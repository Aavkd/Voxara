[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "../..")
$binDir = Join-Path $root "tools/piper/bin"
$modelDir = Join-Path $root "models/piper"
New-Item -ItemType Directory -Force -Path $binDir, $modelDir | Out-Null

# Piper's portable Windows CLI is kept separate from the application process;
# this preserves the GPL boundary while still giving the Node provider a local CLI.
# OHF's current releases ship Python wheels only, so this uses the last official
# portable Windows Piper bundle solely as the external executable.
$piperExe = Join-Path $binDir "piper.exe"
if (-not (Test-Path $piperExe)) {
  $zip = Join-Path $env:TEMP "piper_windows_amd64.zip"
  Invoke-WebRequest -Uri "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip" -OutFile $zip
  $extract = Join-Path $env:TEMP "piper_extract_$PID"
  Expand-Archive -Path $zip -DestinationPath $extract -Force
  $sourceExe = Get-ChildItem -Path $extract -Recurse -Filter piper.exe | Select-Object -First 1
  if (-not $sourceExe) { throw "The Piper archive did not contain piper.exe." }
  $sourceDir = Split-Path -Path $sourceExe.FullName -Parent
  Copy-Item -Path (Join-Path $sourceDir "*") -Destination $binDir -Recurse -Force
  Remove-Item -Path $extract -Recurse -Force
}

& $piperExe --help | Out-Null

$voices = @(
  @{ Directory = "siwis"; Name = "fr_FR-siwis-medium" },
  @{ Directory = "upmc"; Name = "fr_FR-upmc-medium" },
  @{ Directory = "tom"; Name = "fr_FR-tom-medium" }
)
foreach ($voice in $voices) {
  $name = $voice.Name
  $base = "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/$($voice.Directory)/medium/$name"
  foreach ($extension in @(".onnx", ".onnx.json")) {
    $destination = Join-Path $modelDir "$name$extension"
    if (-not (Test-Path $destination)) {
      Write-Host "Downloading $name$extension"
      Invoke-WebRequest -Uri "$base$extension" -OutFile $destination
    }
  }
}

Write-Host "Piper is ready: $piperExe"
