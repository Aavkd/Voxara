import { CancellablePlaybackQueue } from "../src/audio/player";
import { AudioBuffer, AudioOutput, PlaybackResult } from "../src/audio/types";
import { PCM16_MONO_16KHZ, createToneWav } from "../src/audio/wav";

class MockAudioOutput implements AudioOutput {
  played = 0;
  stopped = 0;

  async play(_audio: AudioBuffer, signal?: AbortSignal): Promise<PlaybackResult> {
    this.played += 1;
    const startedAt = Date.now();

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          completed: true,
          interrupted: false,
          durationMs: Date.now() - startedAt,
        });
      }, 500);

      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve({
          completed: false,
          interrupted: true,
          durationMs: Date.now() - startedAt,
        });
      }, { once: true });
    });
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }
}

describe("CancellablePlaybackQueue", () => {
  it("plays queued audio and returns to idle", async () => {
    const output = new MockAudioOutput();
    const queue = new CancellablePlaybackQueue(output);

    const result = await queue.play(shortTone());

    expect(result.completed).toBe(true);
    expect(output.played).toBe(1);
    expect(queue.state).toBe("idle");
  });

  it("stops active playback quickly and flushes pending audio", async () => {
    const output = new MockAudioOutput();
    const queue = new CancellablePlaybackQueue(output);

    const first = queue.play(shortTone());
    const second = queue.play(shortTone());
    await delay(25);

    const stoppedInMs = await queue.stop();
    const firstResult = await first;
    const secondResult = await second;

    expect(stoppedInMs).toBeLessThan(200);
    expect(firstResult.interrupted).toBe(true);
    expect(secondResult.interrupted).toBe(true);
    expect(output.stopped).toBe(1);
    expect(queue.state).toBe("interrupted");
  });
});

function shortTone(): AudioBuffer {
  return createToneWav(440, 100, PCM16_MONO_16KHZ);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
