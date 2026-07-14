/**
 * Desktop host — one persistent PowerShell helper per session, the desktop
 * twin of the browser bridge (docs/phase-c3-computer-control.md §9.3).
 *
 * UIA element refs must stay alive between a desktop_read and the following
 * desktop_act, and a fresh powershell.exe per call costs about a second — so
 * the helper is resident: spawned on first desktop intent, speaking
 * request/response JSON lines over stdio with correlation ids and per-request
 * timeouts (§7.2 discipline). Crash/exit ⇒ automatic restart on the next
 * intent, and every ref from the previous process generation is stale.
 *
 * The helper script is a STATIC asset owned by the application (written
 * verbatim to the state root at spawn); the model never contributes to it.
 * Untrusted values (window titles, text, launch args) travel as JSON data,
 * never interpolated into code.
 */

import { ChildProcess, spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ensureStateDir } from "../engine/statePaths";

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

/** Guidance relayed verbatim when the host cannot run (non-Windows CI). */
export const DESKTOP_HOST_UNAVAILABLE_MESSAGE =
  "le contrôle du bureau n'est disponible que sous Windows";

export interface DesktopHostOptions {
  /** Test override: spawn this command instead of the PowerShell helper. */
  spawnOverride?: { command: string; args: string[] };
  requestTimeoutMs?: number;
  /** State-root override for the helper script file (tests). */
  baseDir?: string;
  platform?: NodeJS.Platform;
}

interface InFlightRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class DesktopHost {
  private readonly options: DesktopHostOptions;
  private child?: ChildProcess;
  private readonly inFlight = new Map<string, InFlightRequest>();
  private stdoutCarry = "";
  /**
   * Increments on every (re)spawn: an element ref minted under an older
   * generation is stale by definition — the AutomationElement cache died
   * with the previous helper process.
   */
  private generationCounter = 0;

  constructor(options: DesktopHostOptions = {}) {
    this.options = options;
  }

  get generation(): number {
    return this.generationCounter;
  }

  isRunning(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  /**
   * Send one command to the helper and await its correlated response,
   * spawning (or respawning) the helper first when needed.
   */
  async request<T = unknown>(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number
  ): Promise<T> {
    this.ensureStarted();
    const child = this.child!;
    const id = crypto.randomUUID();
    const budget =
      timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inFlight.delete(id);
        reject(
          new Error(`the desktop host did not answer "${command}" within ${budget} ms`)
        );
      }, budget);
      timer.unref?.();
      this.inFlight.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      // Non-ASCII is \u-escaped so the JSON survives the console code page
      // of the PowerShell child regardless of locale.
      child.stdin?.write(`${escapeNonAscii(JSON.stringify({ id, command, params }))}\n`);
    });
  }

  /**
   * Abort in-flight work by killing the helper (§4.3: mid-step interruption
   * of a UIA call). The next intent respawns it; all refs go stale, which
   * degrades safely into a confirmation, never a wrong-target action.
   */
  async interrupt(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.failAllInFlight(new Error("desktop host interrupted"));
    if (child && child.exitCode === null) {
      child.kill();
    }
  }

  async stop(): Promise<void> {
    await this.interrupt();
  }

  private ensureStarted(): void {
    if (this.isRunning()) {
      return;
    }
    const platform = this.options.platform ?? process.platform;
    if (!this.options.spawnOverride && platform !== "win32") {
      throw new Error(DESKTOP_HOST_UNAVAILABLE_MESSAGE);
    }

    const target = this.options.spawnOverride ?? this.resolvePowerShellTarget();
    const child = spawn(target.command, target.args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.generationCounter++;
    this.stdoutCarry = "";
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr?.on("data", () => undefined); // bounded by the pipe; never fatal
    child.stdin?.on("error", () => undefined);
    child.on("error", (err) => {
      // Ignore events from a child we already replaced (e.g. after interrupt):
      // failing in-flight here would abort requests belonging to the new child.
      if (this.child !== child) {
        return;
      }
      this.child = undefined;
      this.failAllInFlight(
        new Error(`the desktop host failed to start: ${err.message}`)
      );
    });
    child.on("close", () => {
      if (this.child !== child) {
        return;
      }
      this.child = undefined;
      this.failAllInFlight(
        new Error("the desktop host exited mid-request — refs are stale; retry the read")
      );
    });
  }

  private resolvePowerShellTarget(): { command: string; args: string[] } {
    // -File keeps the (large) resident script off the command line; the
    // script file is rewritten from the embedded constant on every spawn so
    // it always matches this build.
    const state = ensureStateDir(this.options.baseDir);
    const controlDir = path.join(state.root, "control");
    fs.mkdirSync(controlDir, { recursive: true });
    const scriptFile = path.join(controlDir, "desktop-host.ps1");
    fs.writeFileSync(scriptFile, DESKTOP_HOST_SCRIPT, "utf8");
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptFile,
      ],
    };
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutCarry += chunk.toString("utf8");
    let newlineIndex = this.stdoutCarry.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutCarry.slice(0, newlineIndex).trim();
      this.stdoutCarry = this.stdoutCarry.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleLine(line);
      }
      newlineIndex = this.stdoutCarry.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: { id?: string; ok?: boolean; result?: unknown; error?: string };
    try {
      message = JSON.parse(line);
    } catch {
      return; // stray PowerShell noise, never fatal
    }
    const pending = message.id ? this.inFlight.get(message.id) : undefined;
    if (!pending) {
      return;
    }
    this.inFlight.delete(message.id!);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(
        new Error(message.error || "the desktop host reported an unspecified error")
      );
    }
  }

  private failAllInFlight(error: Error): void {
    for (const [id, pending] of this.inFlight) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.inFlight.delete(id);
    }
  }
}

function escapeNonAscii(json: string): string {
  return json.replace(
    /[\u0080-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

// ── Process-wide singleton ───────────────────────────────────────────

let hostSingleton: DesktopHost | undefined;

export function getDesktopHost(): DesktopHost {
  if (!hostSingleton) {
    hostSingleton = new DesktopHost();
  }
  return hostSingleton;
}

/**
 * The resident helper script (§9.3). Commands: ping, list_windows, elements,
 * invoke, set_value, focus, close, type, keys, resolve_app, launch,
 * last_input. One JSON request per stdin line, one JSON response per stdout
 * line. Ambiguous window targets return `{ ambiguous: [titles] }` as data so
 * the executor can relay the candidates instead of guessing (§9.1).
 */
const DESKTOP_HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class VoxaraDesktopNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
}
'@

$script:Refs = @{}
$script:RefCounter = 0

function Normalize-Text([string]$text) {
  if ($null -eq $text) { return '' }
  $decomposed = $text.Normalize([System.Text.NormalizationForm]::FormD)
  $builder = New-Object System.Text.StringBuilder
  foreach ($ch in $decomposed.ToCharArray()) {
    if ([System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($ch) -ne [System.Globalization.UnicodeCategory]::NonSpacingMark) {
      [void]$builder.Append($ch)
    }
  }
  $builder.ToString().ToLowerInvariant()
}

function Clip-Text([string]$text, [int]$max) {
  if ($null -eq $text) { return '' }
  $clean = $text.Trim()
  if ($clean.Length -gt $max) { return $clean.Substring(0, $max) }
  $clean
}

function Get-TopWindows {
  Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object {
    [pscustomobject]@{
      title = $_.MainWindowTitle
      process = $_.ProcessName
      procId = $_.Id
      handle = [int64]$_.MainWindowHandle
    }
  }
}

function Get-WindowByHandle([string]$handleStr) {
  $target = [int64]$handleStr
  $win = Get-TopWindows | Where-Object { $_.handle -eq $target } | Select-Object -First 1
  if ($null -eq $win) { throw "window $handleStr is no longer open" }
  $win
}

# Resolve a window from either a stable handle ref (w<handle>, exact — no
# ambiguity, never the wrong window) or a title substring. Ambiguous title
# matches come back with each candidate's ref so the caller can pin one.
function Resolve-WindowOrCandidates($params) {
  $handle = [string]$params.handle
  if ($handle) { return @{ window = (Get-WindowByHandle $handle) } }
  $needle = [string]$params.target
  if (-not $needle) { throw 'a target window (title substring or w<handle> ref) is required' }
  $normalized = Normalize-Text $needle
  $found = @(Get-TopWindows | Where-Object { (Normalize-Text $_.title).Contains($normalized) })
  if ($found.Count -eq 0) { throw "no open window title contains '$needle'" }
  if ($found.Count -gt 1) {
    return @{ ambiguous = @($found | ForEach-Object { "$($_.title) [w$($_.handle)]" } | Select-Object -First 8) }
  }
  @{ window = $found[0] }
}

function Escape-SendKeys([string]$text) {
  $special = '+^%~(){}[]'
  $builder = New-Object System.Text.StringBuilder
  foreach ($ch in $text.ToCharArray()) {
    if ($special.IndexOf($ch) -ge 0) { [void]$builder.Append('{').Append($ch).Append('}') }
    else { [void]$builder.Append($ch) }
  }
  $builder.ToString()
}

function Focus-Window($win) {
  $handle = [IntPtr][int64]$win.handle
  if ([VoxaraDesktopNative]::IsIconic($handle)) { [void][VoxaraDesktopNative]::ShowWindow($handle, 9) }
  [void][VoxaraDesktopNative]::SetForegroundWindow($handle)
  Start-Sleep -Milliseconds 250
  return ([VoxaraDesktopNative]::GetForegroundWindow() -eq $handle)
}

function Test-Interesting($el) {
  $patterns = @(
    [System.Windows.Automation.InvokePattern]::Pattern,
    [System.Windows.Automation.ValuePattern]::Pattern,
    [System.Windows.Automation.TogglePattern]::Pattern,
    [System.Windows.Automation.SelectionItemPattern]::Pattern,
    [System.Windows.Automation.ExpandCollapsePattern]::Pattern
  )
  foreach ($pattern in $patterns) {
    $obj = $null
    if ($el.TryGetCurrentPattern($pattern, [ref]$obj)) { return $true }
  }
  $controlType = $el.Current.ControlType
  if ($controlType -eq [System.Windows.Automation.ControlType]::Text -or
      $controlType -eq [System.Windows.Automation.ControlType]::Header) {
    return [bool]$el.Current.Name
  }
  $false
}

function Build-ElementEntry($el, [string]$ref) {
  $entry = @{
    ref = $ref
    controlType = ($el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '')
    name = (Clip-Text $el.Current.Name 80)
  }
  $state = @{}
  if (-not $el.Current.IsEnabled) { $state.enabled = $false }
  if ($el.Current.HasKeyboardFocus) { $state.focused = $true }
  $toggle = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) {
    $state.checked = ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On)
  }
  $expand = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expand)) {
    if ($expand.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { $state.expanded = $true }
  }
  $valuePattern = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
    if (-not $el.Current.IsPassword) {
      $value = Clip-Text $valuePattern.Current.Value 80
      if ($value) { $state.value = $value }
    }
  }
  if ($state.Count -gt 0) { $entry.state = $state }
  $entry
}

function Walk-Element($el, $list, [int]$max, [int]$depth) {
  if ($list.Count -ge $max -or $depth -gt 14) { return }
  if ($depth -gt 0 -and (Test-Interesting $el)) {
    $script:RefCounter++
    $ref = 'd' + $script:RefCounter
    $script:Refs[$ref] = $el
    [void]$list.Add((Build-ElementEntry $el $ref))
  }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $child = $walker.GetFirstChild($el)
  while ($null -ne $child -and $list.Count -lt $max) {
    Walk-Element $child $list $max ($depth + 1)
    $child = $walker.GetNextSibling($child)
  }
}

function Get-Elements($params) {
  $resolution = Resolve-WindowOrCandidates $params
  if ($resolution.ambiguous) { return @{ ambiguous = $resolution.ambiguous } }
  $win = $resolution.window
  $script:Refs = @{}
  $script:RefCounter = 0
  $max = 200
  if ($params.max_elements) { $max = [int]$params.max_elements }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$win.handle)
  $list = New-Object System.Collections.ArrayList
  Walk-Element $root $list $max 0
  @{ window = $win.title; process = $win.process; elements = $list }
}

function Get-Ref([string]$ref) {
  $el = $script:Refs[$ref]
  if ($null -eq $el) { throw "stale or unknown ref '$ref' - call desktop_read what=elements again" }
  $el
}

function Invoke-Ref($params) {
  $el = Get-Ref ([string]$params.ref)
  $name = Clip-Text $el.Current.Name 80
  $invoke = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
    $invoke.Invoke()
    return @{ invoked = $name }
  }
  $toggle = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) {
    $toggle.Toggle()
    return @{ toggled = $name; state = [string]$toggle.Current.ToggleState }
  }
  $selection = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
    $selection.Select()
    return @{ selected = $name }
  }
  $expand = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expand)) {
    if ($expand.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { $expand.Collapse() }
    else { $expand.Expand() }
    return @{ expanded = $name; state = [string]$expand.Current.ExpandCollapseState }
  }
  throw "element '$name' supports no invokable pattern"
}

function Set-RefValue($params) {
  $el = Get-Ref ([string]$params.ref)
  $valuePattern = $null
  if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
    throw "element '$(Clip-Text $el.Current.Name 80)' does not accept a value (no ValuePattern)"
  }
  $valuePattern.SetValue([string]$params.value)
  @{ set = (Clip-Text $el.Current.Name 80); value = (Clip-Text ([string]$params.value) 80) }
}

function Send-Text($params) {
  $resolution = Resolve-WindowOrCandidates $params
  if ($resolution.ambiguous) { return @{ ambiguous = $resolution.ambiguous } }
  $win = $resolution.window
  if (-not (Focus-Window $win)) { throw "could not bring '$($win.title)' to the foreground - input aborted" }
  [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys ([string]$params.text)))
  if ([VoxaraDesktopNative]::GetForegroundWindow() -ne [IntPtr][int64]$win.handle) {
    throw "the foreground window changed while typing into '$($win.title)' - verify what was typed"
  }
  @{ typed = ([string]$params.text).Length; window = $win.title; ref = ('w' + $win.handle) }
}

function Send-TextAndSubmit($params) {
  $resolution = Resolve-WindowOrCandidates $params
  if ($resolution.ambiguous) { return @{ ambiguous = $resolution.ambiguous } }
  $win = $resolution.window
  if (-not (Focus-Window $win)) { throw "could not bring '$($win.title)' to the foreground - input aborted" }
  [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys ([string]$params.text)))
  if ([VoxaraDesktopNative]::GetForegroundWindow() -ne [IntPtr][int64]$win.handle) {
    throw "the foreground window changed while typing into '$($win.title)' - nothing was submitted"
  }
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  @{ typed = ([string]$params.text).Length; submitted = $true; window = $win.title; ref = ('w' + $win.handle) }
}

function Send-Chord($params) {
  $resolution = Resolve-WindowOrCandidates $params
  if ($resolution.ambiguous) { return @{ ambiguous = $resolution.ambiguous } }
  $win = $resolution.window
  $spec = ([string]$params.keys).Trim().ToLowerInvariant()
  if (-not $spec) { throw 'keys requires a key or chord, e.g. "enter" or "ctrl+s"' }
  $mods = ''
  $key = $null
  foreach ($part in ($spec -split '\+' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
    switch ($part) {
      'ctrl' { $mods += '^' }
      'control' { $mods += '^' }
      'alt' { $mods += '%' }
      'shift' { $mods += '+' }
      'win' { throw 'the Windows key is not supported' }
      default {
        if ($null -ne $key) { throw "chord '$spec' names more than one non-modifier key" }
        $key = $part
      }
    }
  }
  if ($null -eq $key) { throw "chord '$spec' names no key" }
  $named = @{
    enter = '{ENTER}'; tab = '{TAB}'; escape = '{ESC}'; esc = '{ESC}'
    backspace = '{BACKSPACE}'; delete = '{DELETE}'; del = '{DELETE}'
    up = '{UP}'; down = '{DOWN}'; left = '{LEFT}'; right = '{RIGHT}'
    home = '{HOME}'; end = '{END}'; pageup = '{PGUP}'; pgup = '{PGUP}'
    pagedown = '{PGDN}'; pgdn = '{PGDN}'; insert = '{INSERT}'; space = ' '
  }
  if ($named.ContainsKey($key)) { $token = $named[$key] }
  elseif ($key -match '^f([1-9]|1[0-9]|2[0-4])$') { $token = '{' + $key.ToUpperInvariant() + '}' }
  elseif ($key.Length -eq 1) { $token = Escape-SendKeys $key }
  else { throw "unknown key '$key'" }
  if (-not (Focus-Window $win)) { throw "could not bring '$($win.title)' to the foreground - input aborted" }
  [System.Windows.Forms.SendKeys]::SendWait($mods + $token)
  @{ sent = $spec; window = $win.title; ref = ('w' + $win.handle) }
}

function Close-TargetWindow($params) {
  $resolution = Resolve-WindowOrCandidates $params
  if ($resolution.ambiguous) { return @{ ambiguous = $resolution.ambiguous } }
  $win = $resolution.window
  $process = Get-Process -Id $win.procId -ErrorAction SilentlyContinue
  if ($null -eq $process) { throw "the process owning '$($win.title)' is already gone" }
  [void]$process.CloseMainWindow()
  @{ closed = $win.title; process = $win.process; graceful = $true }
}

function Focus-TargetWindow($params) {
  $resolution = Resolve-WindowOrCandidates $params
  if ($resolution.ambiguous) { return @{ ambiguous = $resolution.ambiguous } }
  $win = $resolution.window
  if (-not (Focus-Window $win)) { throw "could not bring '$($win.title)' to the foreground" }
  @{ focused = $win.title; ref = ('w' + $win.handle) }
}

function Resolve-App($params) {
  $name = [string]$params.name
  if (-not $name) { throw 'an application name is required' }
  $needle = Normalize-Text $name
  $candidates = New-Object System.Collections.ArrayList
  $seen = @{}

  $shell = New-Object -ComObject WScript.Shell
  $startMenus = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
  )
  foreach ($dir in $startMenus) {
    if (-not (Test-Path $dir)) { continue }
    foreach ($lnk in (Get-ChildItem -Path $dir -Recurse -Filter *.lnk -ErrorAction SilentlyContinue)) {
      if (-not (Normalize-Text $lnk.BaseName).Contains($needle)) { continue }
      if ($lnk.BaseName -match '(?i)uninstall|desinstall') { continue }
      $target = $null
      try { $target = $shell.CreateShortcut($lnk.FullName).TargetPath } catch { continue }
      # Skip shortcuts whose TargetPath is an unexpanded KNOWNFOLDERID GUID.
      if (-not $target -or $target -match '^\{' -or $target -notmatch '(?i)\.exe$' -or -not (Test-Path $target)) { continue }
      $dedupe = $target.ToLowerInvariant()
      if ($seen.ContainsKey($dedupe)) { continue }
      $seen[$dedupe] = $true
      [void]$candidates.Add(@{ name = $lnk.BaseName; path = $target; kind = 'exe' })
    }
  }

  foreach ($hive in @('HKCU:', 'HKLM:')) {
    $appPaths = Join-Path $hive 'Software\Microsoft\Windows\CurrentVersion\App Paths'
    if (-not (Test-Path $appPaths)) { continue }
    foreach ($key in (Get-ChildItem $appPaths -ErrorAction SilentlyContinue)) {
      $base = [System.IO.Path]::GetFileNameWithoutExtension($key.PSChildName)
      if (-not (Normalize-Text $base).Contains($needle)) { continue }
      $target = $null
      try { $target = (Get-Item $key.PSPath).GetValue('') } catch { continue }
      if (-not $target) { continue }
      $target = $target.Trim('"')
      if (-not (Test-Path $target)) { continue }
      $dedupe = $target.ToLowerInvariant()
      if ($seen.ContainsKey($dedupe)) { continue }
      $seen[$dedupe] = $true
      [void]$candidates.Add(@{ name = $base; path = $target; kind = 'exe' })
    }
  }

  foreach ($cmd in @(Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 3)) {
    $dedupe = $cmd.Source.ToLowerInvariant()
    if ($seen.ContainsKey($dedupe)) { continue }
    $seen[$dedupe] = $true
    [void]$candidates.Add(@{ name = $cmd.Name; path = $cmd.Source; kind = 'exe' })
  }

  try {
    foreach ($app in (Get-StartApps -ErrorAction Stop)) {
      if (-not (Normalize-Text $app.Name).Contains($needle)) { continue }
      $dedupe = 'uwp:' + $app.AppID.ToLowerInvariant()
      if ($seen.ContainsKey($dedupe)) { continue }
      $seen[$dedupe] = $true
      [void]$candidates.Add(@{ name = $app.Name; path = $app.AppID; kind = 'uwp' })
    }
  } catch {}

  @{ candidates = @($candidates | Select-Object -First 8) }
}

function Launch-App($params) {
  $kind = [string]$params.kind
  $target = [string]$params.path
  if (-not $target) { throw 'a resolved path is required to launch' }
  $argList = @()
  if ($params.args) { $argList = @($params.args | ForEach-Object { [string]$_ }) }

  # Snapshot handles BEFORE launch. On Windows 11 a console executable such
  # as powershell.exe is hosted by Windows Terminal: the launched process has
  # MainWindowHandle=0 while a different WindowsTerminal process owns the new
  # top-level window. The new handle must therefore be discovered by diffing
  # the desktop window list, not by inspecting the child process.
  $beforeHandles = @{}
  foreach ($win in @(Get-TopWindows)) {
    $beforeHandles[[string]$win.handle] = $true
  }

  $proc = $null
  if ($kind -eq 'uwp') {
    if ($argList.Count -gt 0) { throw 'launch arguments are not supported for Store apps' }
    Start-Process ('shell:AppsFolder\' + $target)
    $result = @{ launched = $target; kind = 'uwp' }
  } else {
    if (-not (Test-Path $target)) { throw "executable not found: $target" }
    $quoted = @($argList | ForEach-Object {
      if ($_ -match '\s|"') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    })
    if ($quoted.Count -gt 0) { $proc = Start-Process -FilePath $target -ArgumentList $quoted -PassThru }
    else { $proc = Start-Process -FilePath $target -PassThru }
    $result = @{ launched = $target; processId = $proc.Id }
  }

  # Poll for a top-level handle that did not exist in the pre-launch snapshot.
  # Prefer the launched PID when it owns a classic window, then a title/process
  # match, then the sole new window. The title route is what associates
  # powershell.exe with its new "Windows PowerShell" Windows Terminal window.
  $expected = Normalize-Text ([System.IO.Path]::GetFileNameWithoutExtension($target))
  $candidateHandle = $null
  $candidateStablePolls = 0
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 200
    $newWindows = @(Get-TopWindows | Where-Object {
      -not $beforeHandles.ContainsKey([string]$_.handle)
    })
    if ($newWindows.Count -eq 0) {
      $candidateHandle = $null
      $candidateStablePolls = 0
      continue
    }

    $captured = $null
    if ($null -ne $proc) {
      $captured = $newWindows | Where-Object { $_.procId -eq $proc.Id } | Select-Object -First 1
    }
    if ($null -eq $captured -and $expected) {
      $titleMatches = @($newWindows | Where-Object {
        (Normalize-Text $_.title).Contains($expected)
      })
      if ($titleMatches.Count -eq 1) { $captured = $titleMatches[0] }
    }
    if ($null -eq $captured -and $expected) {
      $processMatches = @($newWindows | Where-Object {
        (Normalize-Text $_.process).Contains($expected)
      })
      if ($processMatches.Count -eq 1) { $captured = $processMatches[0] }
    }
    if ($null -eq $captured -and $newWindows.Count -eq 1) {
      $captured = $newWindows[0]
    }
    if ($null -eq $captured) {
      $candidateHandle = $null
      $candidateStablePolls = 0
      continue
    }

    # UWP activation can expose a short-lived top-level handle before reusing
    # an existing window. Returning that transient ref caused the next turn to
    # fail and then fall back to an unrelated user terminal. Require the same
    # NEW handle to survive several consecutive snapshots before binding it.
    $handle = [string]$captured.handle
    if ($candidateHandle -eq $handle) { $candidateStablePolls++ }
    else {
      $candidateHandle = $handle
      $candidateStablePolls = 1
    }
    if ($candidateStablePolls -ge 8) {
      $result.ref = 'w' + [int64]$captured.handle
      $result.window = $captured.title
      $result.process = $captured.process
      $result.windowProcessId = $captured.procId
      break
    }
  }
  if (-not $result.ref) {
    $result.note = 'launched, but no stable new top-level window could be bound; keyboard input is disabled for this launch'
  }
  $result
}

function Get-IdleMs {
  $info = New-Object VoxaraDesktopNative+LASTINPUTINFO
  $info.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($info)
  if (-not [VoxaraDesktopNative]::GetLastInputInfo([ref]$info)) { throw 'GetLastInputInfo failed' }
  $ticks = [System.BitConverter]::ToUInt32([System.BitConverter]::GetBytes([Environment]::TickCount), 0)
  $idle = [int64]$ticks - [int64]$info.dwTime
  if ($idle -lt 0) { $idle += 4294967296 }
  @{ idleMs = $idle }
}

function Handle-Command([string]$command, $params) {
  switch ($command) {
    'ping' { return 'pong' }
    'list_windows' {
      $foreground = [int64][VoxaraDesktopNative]::GetForegroundWindow()
      return @(Get-TopWindows | ForEach-Object {
        @{ title = $_.title; process = $_.process; pid = $_.procId; ref = ('w' + $_.handle); focused = ($_.handle -eq $foreground) }
      })
    }
    'elements' { return Get-Elements $params }
    'invoke' { return Invoke-Ref $params }
    'set_value' { return Set-RefValue $params }
    'focus' { return Focus-TargetWindow $params }
    'close' { return Close-TargetWindow $params }
    'type' { return Send-Text $params }
    'type_submit' { return Send-TextAndSubmit $params }
    'keys' { return Send-Chord $params }
    'resolve_app' { return Resolve-App $params }
    'launch' { return Launch-App $params }
    'last_input' { return Get-IdleMs }
    default { throw "unknown command '$command'" }
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }
  $requestId = $null
  try {
    $request = ConvertFrom-Json -InputObject $line
    $requestId = $request.id
    $params = @{}
    if ($request.params) {
      foreach ($property in $request.params.PSObject.Properties) { $params[$property.Name] = $property.Value }
    }
    $result = Handle-Command ([string]$request.command) $params
    $response = @{ id = $requestId; ok = $true; result = $result }
  } catch {
    $response = @{ id = $requestId; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $response -Compress -Depth 10))
}
`;

/** Exported for the doctor command and tests. */
export { DESKTOP_HOST_SCRIPT };
