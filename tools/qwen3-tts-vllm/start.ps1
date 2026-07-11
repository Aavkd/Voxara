$ErrorActionPreference = "Stop"

# Qwen3-TTS served by vLLM-Omni in Docker (WSL2 backend, GPU passthrough).
#
# Why: the pure-Python qwen_tts wrapper (tools/qwen3-tts) is bottlenecked by
# nested HuggingFace generate loops (~30s per sentence, GPU at ~6%). vLLM-Omni
# has day-0 Qwen3-TTS support with an optimized two-stage pipeline (talker ->
# code2wav, CUDA graphs, chunk streaming) behind the same OpenAI-compatible
# POST /v1/audio/speech endpoint.

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$HfCache = Join-Path $Root "models\huggingface"
$DeployConfig = Join-Path $PSScriptRoot "qwen3_tts.yaml"
$Image = "vllm/vllm-omni:v0.24.0"
$Name = "qwen3-tts-vllm"
$Port = if ($env:QWEN3_TTS_VLLM_PORT) { $env:QWEN3_TTS_VLLM_PORT } else { "8091" }
$Model = if ($env:VOICE_TTS_MODEL) { $env:VOICE_TTS_MODEL } else { "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign" }

# Reuse a running container; remove a stopped leftover.
$Existing = docker ps -a --filter "name=^/$Name$" --format "{{.State}}"
if ($Existing -eq "running") {
  Write-Host "[qwen3-tts-vllm] Container already running on port $Port."
  exit 0
}
if ($Existing) {
  docker rm -f $Name | Out-Null
}

Write-Host "[qwen3-tts-vllm] Starting $Model via vLLM-Omni on http://localhost:$Port"
Write-Host "[qwen3-tts-vllm] HF cache: $HfCache (model weights reused, no re-download)"
Write-Host "[qwen3-tts-vllm] First start compiles CUDA graphs; allow a few minutes."

docker run -d --name $Name `
  --gpus all `
  --shm-size 8g `
  -p "${Port}:8091" `
  -v "${HfCache}:/root/.cache/huggingface" `
  -v "${DeployConfig}:/deploy/qwen3_tts.yaml:ro" `
  --entrypoint vllm-omni `
  $Image `
  serve $Model `
  --deploy-config /deploy/qwen3_tts.yaml `
  --host 0.0.0.0 `
  --port 8091 `
  --trust-remote-code `
  --omni

Write-Host "[qwen3-tts-vllm] Container started. Logs: docker logs -f $Name"
Write-Host "[qwen3-tts-vllm] Health:  curl http://localhost:$Port/health"
