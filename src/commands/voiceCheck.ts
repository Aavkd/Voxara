import { loadConfig, loadVoiceConfig } from "../config/loader";
import { FfmpegMicrophoneCapture } from "../audio/microphone";
import { CancellablePlaybackQueue, SystemAudioOutput } from "../audio/player";
import { EnergyVad, SILENT_CAPTURE_RMS, calculatePcm16Rms } from "../audio/vad";
import { PCM16_MONO_16KHZ, createToneWav, decodePcm16Wav } from "../audio/wav";
import { AudioBuffer, VadLevelStats } from "../audio/types";
import { validatePrompts } from "../prompts/promptLoader";
import { collectFinalTranscript, createSTTProvider } from "../speech/stt/factory";
import { ISTTProvider } from "../speech/stt/ISTTProvider";
import { createTTSProvider, loadVoiceDesignPrompt } from "../speech/tts/factory";
import { ITTSProvider } from "../speech/tts/ITTSProvider";

interface VoiceCheckOptions {
  duration?: string;
  device?: string;
  skipRecord?: boolean;
  skipPlayback?: boolean;
  skipTts?: boolean;
  skipCalibration?: boolean;
  keepRecording?: boolean;
}

interface FrameLevels {
  /** Loudest 20 ms frame RMS. */
  peak: number;
  /** Median RMS of all frames (ambient level). */
  median: number;
  /** Median RMS of frames at or above 30% of the peak (voiced level; equals peak-side energy during speech). */
  activeMedian: number;
}

interface CheckResult {
  name: string;
  ok: boolean;
  details: string;
  warning?: boolean;
}

export async function voiceCheckCommand(options: VoiceCheckOptions): Promise<void> {
  const results: CheckResult[] = [];
  const voice = loadVoiceConfig();
  const durationMs = Math.max(250, Math.round(Number.parseFloat(options.duration || "2") * 1000));

  console.log("Voice check");
  console.log(`Language: ${voice.language}`);
  console.log(`Sample rate: ${voice.sampleRate} Hz`);
  console.log("");

  let sttProvider: ISTTProvider | undefined;
  let ttsProvider: ITTSProvider | undefined;
  let sttReady = false;
  let ttsReady = false;
  let voiceDesignPrompt = "";

  try {
    const config = loadConfig();
    results.push({
      name: "LLM provider",
      ok: true,
      details: `${config.provider} / ${config.model}`,
    });
  } catch (err) {
    results.push({
      name: "LLM provider",
      ok: false,
      details: err instanceof Error ? err.message.split("\n")[0] : String(err),
      warning: true,
    });
  }

  const promptResult = validatePrompts({ promptsDir: voice.promptsDir });
  results.push({
    name: "Prompts",
    ok: promptResult.ok,
    details: promptResult.ok
      ? `${promptResult.checked.length} files in ${promptResult.promptsDir}`
      : promptResult.errors.join("; "),
  });

  try {
    sttProvider = createSTTProvider(voice);
    const sttSetup = await sttProvider.checkSetup();
    sttReady = sttSetup.ok;
    results.push({
      name: "STT backend",
      ok: sttSetup.ok,
      details: sttSetup.details,
    });
  } catch (err) {
    results.push({
      name: "STT backend",
      ok: false,
      details: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    voiceDesignPrompt = loadVoiceDesignPrompt(voice);
    results.push({
      name: "Voice style prompt",
      ok: voiceDesignPrompt.trim().length > 0,
      details: `${voiceDesignPrompt.trim().length} characters loaded from ${voice.promptsDir}`,
    });
  } catch (err) {
    results.push({
      name: "Voice style prompt",
      ok: false,
      details: err instanceof Error ? err.message : String(err),
    });
  }

  if (!options.skipTts) {
    try {
      ttsProvider = createTTSProvider(voice);
      const ttsSetup = await ttsProvider.checkSetup();
      ttsReady = ttsSetup.ok;
      results.push({
        name: "TTS backend",
        ok: ttsSetup.ok,
        details: ttsSetup.details,
        warning: ttsSetup.warning,
      });
    } catch (err) {
      results.push({
        name: "TTS backend",
        ok: false,
        details: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    results.push({
      name: "TTS backend",
      ok: true,
      details: "Skipped by --skip-tts.",
      warning: true,
    });
  }

  const microphone = new FfmpegMicrophoneCapture();
  let recording: AudioBuffer | undefined;
  let recordingDevice: string | undefined;
  let ttsCalibrationAudio: AudioBuffer | undefined;

  if (!options.skipRecord) {
    try {
      const devices = await microphone.listDevices();
      results.push({
        name: "Microphone devices",
        ok: devices.length > 0,
        details: devices.length > 0
          ? devices.map((device) => device.name).join(", ")
          : "No DirectShow microphone devices reported by ffmpeg.",
      });

      const selectedDevice = options.device || devices[0]?.name;
      recordingDevice = selectedDevice;
      const sample = await microphone.record({
        durationMs,
        sampleRate: voice.sampleRate,
        deviceName: selectedDevice,
        keepFile: options.keepRecording,
      });
      recording = sample;

      results.push({
        name: "Microphone recording",
        ok: sample.data.length > 44,
        details: `${Math.round(sample.data.length / 1024)} KB captured from "${selectedDevice ?? "default"}"${sample.filePath ? ` at ${sample.filePath}` : ""}`,
      });
    } catch (err) {
      results.push({
        name: "Microphone recording",
        ok: false,
        details: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    results.push({
      name: "Microphone recording",
      ok: true,
      details: "Skipped by --skip-record.",
      warning: true,
    });
  }

  if (recording) {
    try {
      const pcm = recording.container === "wav" ? decodePcm16Wav(recording.data) : recording;
      const vad = new EnergyVad({
        threshold: voice.vadThreshold,
        speechStartMs: voice.vadSpeechMs,
        silenceEndMs: voice.vadSilenceMs,
        minThreshold: voice.vadMinThreshold,
        sampleRate: voice.sampleRate,
      });
      let hasSpeech = false;
      for (const chunk of chunkAudio(pcm, 20)) {
        for (const event of vad.process(chunk)) {
          if (event.type === "speechStart") {
            hasSpeech = true;
          }
        }
      }
      const stats = vad.levelStats();
      const levels = `peak RMS ${stats.maxEnergy.toFixed(4)}, noise floor ${stats.noiseFloor.toFixed(4)}, threshold ${stats.effectiveThreshold.toFixed(4)}`;
      results.push({
        name: "VAD",
        ok: true,
        details: hasSpeech
          ? `Speech activity detected in recording (${levels}).`
          : describeNoSpeech(stats, recordingDevice),
        warning: !hasSpeech,
      });
    } catch (err) {
      results.push({
        name: "VAD",
        ok: false,
        details: err instanceof Error ? err.message : String(err),
      });
    }

    if (sttProvider && sttReady) {
      try {
        const transcript = await collectFinalTranscript(sttProvider.transcribe(recording, {
          language: voice.language,
        }));
        results.push({
          name: "STT transcript",
          ok: transcript.length > 0,
          details: transcript || "Whisper completed but produced an empty transcript.",
          warning: transcript.length === 0,
        });
      } catch (err) {
        results.push({
          name: "STT transcript",
          ok: false,
          details: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      results.push({
        name: "STT transcript",
        ok: true,
        details: "Skipped because the STT backend is not ready.",
        warning: true,
      });
    }
  } else if (options.skipRecord) {
    results.push({
      name: "STT transcript",
      ok: true,
      details: "Skipped by --skip-record.",
      warning: true,
    });
  }

  if (!options.skipPlayback) {
    const player = new CancellablePlaybackQueue(new SystemAudioOutput());
    const toneFormat = { ...PCM16_MONO_16KHZ, sampleRate: voice.sampleRate };
    try {
      await player.play(createToneWav(440, 450, toneFormat));
      results.push({
        name: "Speaker playback",
        ok: true,
        details: "Played a short 440 Hz test tone.",
      });
    } catch (err) {
      results.push({
        name: "Speaker playback",
        ok: false,
        details: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const longTone = player.play(createToneWav(330, 2000, toneFormat));
      await delay(80);
      const stoppedInMs = await player.stop();
      await longTone;
      results.push({
        name: "Playback cancellation",
        ok: stoppedInMs <= 200,
        details: `Stopped in ${stoppedInMs} ms.`,
      });
    } catch (err) {
      results.push({
        name: "Playback cancellation",
        ok: false,
        details: err instanceof Error ? err.message : String(err),
      });
    }

    if (ttsProvider && ttsReady && voiceDesignPrompt) {
      try {
        const testSentence = voice.language === "fr"
          ? "Bonjour, ceci est un court test de synthese vocale."
          : "Hello, this is a short text to speech test.";
        const probe = startEventLoopProbe();
        const audio = await ttsProvider.synthesize(testSentence, {
          language: voice.language,
          voiceDesignPrompt,
        });
        const maxLagMs = probe.stop();
        ttsCalibrationAudio = audio.audio;
        const playback = await player.play(audio.audio);
        results.push({
          name: "TTS synthesis",
          ok: audio.audio.data.length > 0,
          details: `${Math.round(audio.audio.data.length / 1024)} KB generated in ${audio.latencyMs} ms.`,
        });
        results.push(describeEventLoopLag(maxLagMs));
        results.push({
          name: "TTS playback",
          ok: playback.completed,
          details: playback.completed ? "Played synthesized speech." : "Synthesized speech playback was interrupted.",
          warning: playback.interrupted,
        });
      } catch (err) {
        results.push({
          name: "TTS synthesis",
          ok: false,
          details: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (!options.skipTts) {
      results.push({
        name: "TTS synthesis",
        ok: true,
        details: "Skipped because the TTS backend is not ready.",
        warning: true,
      });
    }
  } else {
    results.push({
      name: "Speaker playback",
      ok: true,
      details: "Skipped by --skip-playback.",
      warning: true,
    });
    if (ttsProvider && ttsReady && voiceDesignPrompt) {
      try {
        const testSentence = voice.language === "fr"
          ? "Bonjour, ceci est un court test de synthese vocale."
          : "Hello, this is a short text to speech test.";
        const probe = startEventLoopProbe();
        const audio = await ttsProvider.synthesize(testSentence, {
          language: voice.language,
          voiceDesignPrompt,
        });
        const maxLagMs = probe.stop();
        ttsCalibrationAudio = audio.audio;
        results.push({
          name: "TTS synthesis",
          ok: audio.audio.data.length > 0,
          details: `${Math.round(audio.audio.data.length / 1024)} KB generated in ${audio.latencyMs} ms. Playback skipped.`,
        });
        results.push(describeEventLoopLag(maxLagMs));
      } catch (err) {
        results.push({
          name: "TTS synthesis",
          ok: false,
          details: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (!options.skipTts) {
      results.push({
        name: "TTS synthesis",
        ok: true,
        details: "Skipped because the TTS backend is not ready.",
        warning: true,
      });
    }
  }

  // ── Calibration: measure the numbers that tune the VAD and barge-in ──
  // (VOICE_VAD_MIN_THRESHOLD, VOICE_BARGEIN_THRESHOLD). Requires the user at
  // the microphone, so it is interactive and skippable.
  if (recording && !options.skipCalibration) {
    try {
      console.log("");
      console.log("Calibration (3 short recordings — follow the prompts)");
      console.log("[1/3] Ambient noise: stay silent for 3 seconds...");
      const silence = await microphone.record({
        durationMs: 3000,
        sampleRate: voice.sampleRate,
        deviceName: recordingDevice,
      });
      const noise = frameLevels(silence);

      console.log("[2/3] Speech level: speak a full sentence, now (5 seconds)...");
      const speech = await microphone.record({
        durationMs: 5000,
        sampleRate: voice.sampleRate,
        deviceName: recordingDevice,
      });
      const spoken = frameLevels(speech);

      let bleed: FrameLevels | undefined;
      if (!options.skipPlayback) {
        console.log("[3/3] Speaker bleed: stay SILENT while the assistant speaks...");
        const bleedSource = ttsCalibrationAudio
          ?? createToneWav(330, 3000, { ...PCM16_MONO_16KHZ, sampleRate: voice.sampleRate });
        const bleedPlayer = new CancellablePlaybackQueue(new SystemAudioOutput());
        const playing = bleedPlayer.play(bleedSource).catch(() => undefined);
        const bleedRecording = await microphone.record({
          durationMs: Math.min(4000, Math.max(1500, audioDurationMs(bleedSource))),
          sampleRate: voice.sampleRate,
          deviceName: recordingDevice,
        });
        await playing;
        bleed = frameLevels(bleedRecording);
      } else {
        console.log("[3/3] Speaker bleed: skipped by --skip-playback.");
      }

      const speechToNoise = noise.peak > 0 ? spoken.peak / noise.peak : Number.POSITIVE_INFINITY;
      results.push({
        name: "Calibration levels",
        ok: spoken.peak >= noise.peak * 3,
        warning: spoken.peak < noise.peak * 3,
        details:
          `noise peak ${noise.peak.toFixed(4)} (median ${noise.median.toFixed(4)}), ` +
          `speech peak ${spoken.peak.toFixed(4)} (voiced median ${spoken.activeMedian.toFixed(4)}), ` +
          `speech/noise x${speechToNoise.toFixed(1)}` +
          (bleed ? `, TTS bleed peak ${bleed.peak.toFixed(4)}` : ""),
      });

      const suggestedMinThreshold = Math.max(noise.peak * 2.5, 0.001);
      console.log("");
      console.log("Calibration suggestions for .env:");
      console.log(`  VOICE_VAD_MIN_THRESHOLD=${suggestedMinThreshold.toFixed(4)} (currently ${voice.vadMinThreshold})`);
      if (bleed) {
        const suggestedBargeIn = Math.max(bleed.peak * 2, noise.peak * 3, 0.001);
        if (spoken.activeMedian > suggestedBargeIn) {
          console.log(`  VOICE_BARGEIN_THRESHOLD=${suggestedBargeIn.toFixed(4)} (speech is comfortably above TTS bleed)`);
        } else {
          console.log(
            `  Speech (voiced median ${spoken.activeMedian.toFixed(4)}) is NOT clearly above the TTS bleed floor ` +
            `(suggested cutoff ${suggestedBargeIn.toFixed(4)}). Barge-in will be unreliable: raise the microphone ` +
            "input level in Windows Sound settings, move the mic away from the speakers, or use headphones. " +
            "Leave VOICE_BARGEIN_THRESHOLD unset to use the adaptive monitor."
          );
        }
      }
    } catch (err) {
      results.push({
        name: "Calibration levels",
        ok: false,
        details: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (!options.skipRecord && options.skipCalibration) {
    results.push({
      name: "Calibration levels",
      ok: true,
      details: "Skipped by --skip-calibration.",
      warning: true,
    });
  }

  console.log("");
  for (const result of results) {
    const marker = result.ok ? (result.warning ? "!" : "ok") : "x";
    console.log(`[${marker}] ${result.name}: ${result.details}`);
  }

  const failed = results.filter((result) => !result.ok && !result.warning);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

function describeNoSpeech(stats: VadLevelStats, deviceName: string | undefined): string {
  const levels = `peak RMS ${stats.maxEnergy.toFixed(4)}, noise floor ${stats.noiseFloor.toFixed(4)}, threshold ${stats.effectiveThreshold.toFixed(4)}`;

  if (stats.maxEnergy < SILENT_CAPTURE_RMS) {
    return (
      `No speech detected — the capture from "${deviceName ?? "default"}" is essentially silent (${levels}). ` +
      "This device is probably not the microphone you are speaking into. " +
      "Pick the right one with --device \"<name>\" (see the device list above), check its input level in Windows Sound settings, " +
      "and make sure \"Let desktop apps access your microphone\" is enabled in Windows Privacy & security > Microphone."
    );
  }

  return (
    `No speech detected (${levels}). Audio was captured but stayed too quiet or too flat for the VAD. ` +
    "Raise the microphone input level in Windows Sound settings, or lower VOICE_VAD_THRESHOLD " +
    `(currently ${stats.configuredThreshold}) toward roughly half the peak, e.g. ${(stats.maxEnergy / 2).toFixed(4)}.`
  );
}

/** Per-20ms-frame RMS statistics of a recording, for calibration. */
function frameLevels(audio: AudioBuffer): FrameLevels {
  const pcm = audio.container === "wav" ? decodePcm16Wav(audio.data) : audio;
  const rmsValues = chunkAudio(pcm, 20)
    .map((frame) => calculatePcm16Rms(frame.data))
    .sort((a, b) => a - b);

  if (rmsValues.length === 0) {
    return { peak: 0, median: 0, activeMedian: 0 };
  }

  const peak = rmsValues[rmsValues.length - 1];
  const median = rmsValues[Math.floor(rmsValues.length / 2)];
  const active = rmsValues.filter((value) => value >= peak * 0.3);
  const activeMedian = active.length > 0 ? active[Math.floor(active.length / 2)] : median;
  return { peak, median, activeMedian };
}

function audioDurationMs(audio: AudioBuffer): number {
  const pcm = audio.container === "wav" ? decodePcm16Wav(audio.data) : audio;
  return Math.round((pcm.data.length / 2 / pcm.format.channels / pcm.format.sampleRate) * 1000);
}

/**
 * Measure how long the Node event loop stalls while other work runs. Long
 * stalls during TTS synthesis delay the barge-in microphone handlers by the
 * same amount, so this number bounds barge-in reactivity.
 */
function startEventLoopProbe(intervalMs = 25): { stop(): number } {
  let last = Date.now();
  let maxLagMs = 0;
  const timer = setInterval(() => {
    const nowTs = Date.now();
    maxLagMs = Math.max(maxLagMs, nowTs - last - intervalMs);
    last = nowTs;
  }, intervalMs);

  return {
    stop(): number {
      clearInterval(timer);
      return maxLagMs;
    },
  };
}

function describeEventLoopLag(maxLagMs: number): CheckResult {
  const blocked = maxLagMs >= 200;
  return {
    name: "Event loop during TTS",
    ok: true,
    warning: blocked,
    details: blocked
      ? `max stall ${maxLagMs} ms during synthesis — stalls this long delay barge-in detection by the same amount.`
      : `max stall ${maxLagMs} ms during synthesis (barge-in stays responsive).`,
  };
}

function chunkAudio(audio: AudioBuffer, frameMs: number): AudioBuffer[] {
  const bytesPerFrame = Math.max(
    2,
    Math.floor((audio.format.sampleRate * frameMs) / 1000) * audio.format.channels * 2
  );
  const chunks: AudioBuffer[] = [];

  for (let offset = 0; offset < audio.data.length; offset += bytesPerFrame) {
    chunks.push({
      data: audio.data.subarray(offset, offset + bytesPerFrame),
      format: audio.format,
      container: "pcm",
    });
  }

  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
