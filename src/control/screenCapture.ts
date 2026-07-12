import { execFile } from "child_process";
import { promisify } from "util";
import { ScreenCaptureRequest, ScreenImageResult } from "./types";

const execFileAsync = promisify(execFile);

export type PowerShellRunner = (
  encodedCommand: string,
  env: NodeJS.ProcessEnv
) => Promise<string>;

export interface ScreenCaptureDependencies {
  platform?: NodeJS.Platform;
  runPowerShell?: PowerShellRunner;
}

/** Capture and downscale a Windows screen/window without a native npm addon. */
export async function captureScreen(
  request: ScreenCaptureRequest,
  dependencies: ScreenCaptureDependencies = {}
): Promise<ScreenImageResult> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("screen_view is currently available on Windows only");
  }
  if (request.target === "window" && !request.windowTitle?.trim()) {
    throw new Error("window_title is required when target is window");
  }

  const maxEdge = Number.isFinite(request.maxEdge) && (request.maxEdge ?? 0) > 0
    ? Math.floor(request.maxEdge!)
    : 1568;
  const script = buildCaptureScript();
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const runner = dependencies.runPowerShell ?? defaultPowerShellRunner;
  const output = (await runner(encoded, {
    ...process.env,
    VOXARA_CAPTURE_TARGET: request.target,
    VOXARA_WINDOW_TITLE: request.windowTitle ?? "",
    VOXARA_MAX_EDGE: String(maxEdge),
  })).trim();

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(output)) {
    throw new Error("screen capture returned invalid image data");
  }
  return { kind: "image", mimeType: "image/png", base64: output };
}

async function defaultPowerShellRunner(
  encodedCommand: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
    { env, maxBuffer: 20 * 1024 * 1024, windowsHide: true }
  );
  return stdout;
}

/** The title travels through the environment; it is never interpolated into code. */
function buildCaptureScript(): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class VoxaraNative {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

$bitmap = $null
$graphics = $null
$scaled = $null
$scaledGraphics = $null
$stream = $null
try {
  if ($env:VOXARA_CAPTURE_TARGET -eq 'window') {
    $needle = $env:VOXARA_WINDOW_TITLE
    $process = Get-Process | Where-Object {
      $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0
    } | Select-Object -First 1
    if ($null -eq $process) { throw "No visible window title contains '$needle'" }
    $rect = New-Object VoxaraNative+RECT
    if (-not [VoxaraNative]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) { throw 'GetWindowRect failed' }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) { throw 'Window has no capturable area' }
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    try {
      if (-not [VoxaraNative]::PrintWindow($process.MainWindowHandle, $hdc, 2)) { throw 'PrintWindow failed' }
    } finally { $graphics.ReleaseHdc($hdc) }
  } else {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
  }

  $maxEdge = [Math]::Max(1, [int]$env:VOXARA_MAX_EDGE)
  $longEdge = [Math]::Max($bitmap.Width, $bitmap.Height)
  $output = $bitmap
  if ($longEdge -gt $maxEdge) {
    $ratio = $maxEdge / [double]$longEdge
    $newWidth = [Math]::Max(1, [int][Math]::Round($bitmap.Width * $ratio))
    $newHeight = [Math]::Max(1, [int][Math]::Round($bitmap.Height * $ratio))
    $scaled = New-Object System.Drawing.Bitmap($newWidth, $newHeight)
    $scaledGraphics = [System.Drawing.Graphics]::FromImage($scaled)
    $scaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $scaledGraphics.DrawImage($bitmap, 0, 0, $newWidth, $newHeight)
    $output = $scaled
  }
  $stream = New-Object System.IO.MemoryStream
  $output.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  [Convert]::ToBase64String($stream.ToArray())
} finally {
  if ($stream) { $stream.Dispose() }
  if ($scaledGraphics) { $scaledGraphics.Dispose() }
  if ($scaled) { $scaled.Dispose() }
  if ($graphics) { $graphics.Dispose() }
  if ($bitmap) { $bitmap.Dispose() }
}
`;
}
