$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Venv = Join-Path $Root ".venv-faster-whisper"
$Python = Join-Path $Venv "Scripts\python.exe"
$EnvFile = Join-Path $Root ".env"

if (-not (Test-Path $Python)) {
  Write-Host "[faster-whisper] Virtual environment missing; running setup first..."
  & (Join-Path $PSScriptRoot "setup.ps1")
}

if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    $Line = $_.Trim()
    if ($Line -eq "" -or $Line.StartsWith("#") -or -not $Line.Contains("=")) {
      return
    }

    $Key, $Value = $Line.Split("=", 2)
    $Key = $Key.Trim()
    $Value = $Value.Trim().Trim('"').Trim("'")
    if ($Key -match "^(VOICE_STT_MODEL|VOICE_LANGUAGE|FASTER_WHISPER_DEVICE|FASTER_WHISPER_COMPUTE)$") {
      [Environment]::SetEnvironmentVariable($Key, $Value, "Process")
    }
  }
}

if (-not $env:VOICE_STT_MODEL) {
  $env:VOICE_STT_MODEL = "large-v3-turbo"
}

if (-not $env:FASTER_WHISPER_HOST) {
  $env:FASTER_WHISPER_HOST = "127.0.0.1"
}

if (-not $env:FASTER_WHISPER_PORT) {
  $env:FASTER_WHISPER_PORT = "7862"
}

if (-not $env:HF_HOME) {
  $env:HF_HOME = Join-Path $Root "models\huggingface"
}

Write-Host "[faster-whisper] Starting service at http://$($env:FASTER_WHISPER_HOST):$($env:FASTER_WHISPER_PORT)"
Write-Host "[faster-whisper] Model: $($env:VOICE_STT_MODEL)"
Write-Host "[faster-whisper] First launch can be slow while model weights download."

& $Python -m uvicorn server:app --app-dir $PSScriptRoot --host $env:FASTER_WHISPER_HOST --port $env:FASTER_WHISPER_PORT
