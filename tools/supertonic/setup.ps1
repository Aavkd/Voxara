[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "../..")
$assetsDir = Join-Path $root "models/supertonic"
$helperDir = Join-Path $assetsDir "nodejs"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "git is required to download Supertonic. Install Git for Windows first."
}
if (-not (Get-Command git-lfs -ErrorAction SilentlyContinue)) {
  throw "git-lfs is required to download Supertonic ONNX weights. Install it, run 'git lfs install', then retry."
}

if (-not (Test-Path (Join-Path $assetsDir ".git"))) {
  git clone https://huggingface.co/Supertone/supertonic-3 $assetsDir
} else {
  git -C $assetsDir pull --ff-only
}

New-Item -ItemType Directory -Force -Path $helperDir | Out-Null
# The official MIT Node helper is stored alongside the model assets. It imports
# onnxruntime-node from this project's node_modules and always uses CPU here.
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/supertone-inc/supertonic/main/nodejs/helper.js" -OutFile (Join-Path $helperDir "helper.mjs")

Write-Host "Supertonic is ready: $assetsDir"
