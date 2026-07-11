$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Venv = Join-Path $Root ".venv-qwen3-tts"
$Python = Join-Path $Venv "Scripts\python.exe"
$EnvFile = Join-Path $Root ".env"

if (-not (Test-Path $Python)) {
  Write-Host "[qwen3-tts] Virtual environment missing; running setup first..."
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
    if ($Key -match "^(VOICE_TTS_MODEL|VOICE_TTS_BASE_URL)$") {
      [Environment]::SetEnvironmentVariable($Key, $Value, "Process")
    }
  }
}

if (-not $env:VOICE_TTS_MODEL) {
  $env:VOICE_TTS_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
}

if (-not $env:QWEN3_TTS_HOST) {
  $env:QWEN3_TTS_HOST = "127.0.0.1"
}

if (-not $env:QWEN3_TTS_PORT) {
  $env:QWEN3_TTS_PORT = "7861"
}

if (-not $env:HF_HOME) {
  $env:HF_HOME = Join-Path $Root "models\huggingface"
}

Write-Host "[qwen3-tts] Starting service at http://$($env:QWEN3_TTS_HOST):$($env:QWEN3_TTS_PORT)"
Write-Host "[qwen3-tts] Model: $($env:VOICE_TTS_MODEL)"
Write-Host "[qwen3-tts] First launch can be slow while model weights download."

& $Python -m uvicorn server:app --app-dir $PSScriptRoot --host $env:QWEN3_TTS_HOST --port $env:QWEN3_TTS_PORT
