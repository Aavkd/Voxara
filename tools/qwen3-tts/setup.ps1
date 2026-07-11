$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Venv = Join-Path $Root ".venv-qwen3-tts"
$Python = Join-Path $Venv "Scripts\python.exe"
$Requirements = Join-Path $PSScriptRoot "requirements.txt"

function New-QwenVenv {
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
      Write-Host "[qwen3-tts] Skipping unavailable Python candidate: $($Candidate -join ' ')"
    }
  }

  throw "Could not create a Python virtual environment. Install Python 3.12 or 3.11 and retry."
}

Write-Host "[qwen3-tts] Creating Python virtual environment..."
New-QwenVenv

Write-Host "[qwen3-tts] Upgrading packaging tools..."
& $Python -m pip install -U pip setuptools wheel

Write-Host "[qwen3-tts] Installing CUDA PyTorch..."
& $Python -m pip install -U torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124

Write-Host "[qwen3-tts] Installing Qwen3-TTS wrapper dependencies..."
& $Python -m pip install -r $Requirements

Write-Host "[qwen3-tts] Setup complete."
Write-Host "[qwen3-tts] Start with: npm run tts:start"
