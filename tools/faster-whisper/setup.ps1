$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Venv = Join-Path $Root ".venv-faster-whisper"
$Python = Join-Path $Venv "Scripts\python.exe"
$Requirements = Join-Path $PSScriptRoot "requirements.txt"

function New-WhisperVenv {
  $Candidates = @(
    @("py", "-3.12"),
    @("py", "-3.11"),
    @("python")
  )

  foreach ($Candidate in $Candidates) {
    $Exe = $Candidate[0]
    $Args = @()
    if ($Candidate.Length -gt 1) {
      $Args = $Candidate[1..($Candidate.Length - 1)]
    }

    try {
      & $Exe @Args --version | Out-Host
      & $Exe @Args -m venv $Venv
      if (Test-Path $Python) {
        return
      }
    } catch {
      Write-Host "[faster-whisper] Skipping unavailable Python candidate: $($Candidate -join ' ')"
    }
  }

  throw "Could not create a Python virtual environment. Install Python 3.12 or 3.11 and retry."
}

Write-Host "[faster-whisper] Creating Python virtual environment..."
New-WhisperVenv

Write-Host "[faster-whisper] Upgrading packaging tools..."
& $Python -m pip install -U pip setuptools wheel

Write-Host "[faster-whisper] Installing faster-whisper + CUDA runtime DLLs..."
& $Python -m pip install -r $Requirements

Write-Host "[faster-whisper] Setup complete."
Write-Host "[faster-whisper] Start with: npm run stt:start"
