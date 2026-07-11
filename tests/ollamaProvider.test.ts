import http from "http";
import { AddressInfo } from "net";
import { OllamaProvider } from "../src/providers/ollama";
import { AppConfig } from "../src/types";

type RequestHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => void | Promise<void>;

describe("OllamaProvider", () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (!server) return;

    await new Promise<void>((resolve, reject) => {
      server?.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    server = undefined;
  });

  it("sends a non-streaming prompt to the native chat API", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const provider = await createTestProvider(async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api/chat");
      capturedBody = await readJson(req);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          message: { role: "assistant", content: "Bonjour" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 7,
          eval_count: 3,
        })
      );
    });

    const result = await provider.prompt({
      prompt: "Dis bonjour",
      systemPrompt: "Answer in French.",
      temperature: 0.25,
      maxTokens: 32,
    });

    expect(result.text).toBe("Bonjour");
    expect(result.inputTokens).toBe(7);
    expect(result.outputTokens).toBe(3);
    expect(result.totalTokens).toBe(10);
    expect(capturedBody).toMatchObject({
      model: "qwen3:8b",
      stream: false,
      options: {
        temperature: 0.25,
        num_predict: 32,
      },
      messages: [
        { role: "system", content: "Answer in French." },
        { role: "user", content: "Dis bonjour" },
      ],
    });
  });

  it("parses streaming chat responses incrementally and maps model role to assistant", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const provider = await createTestProvider(async (req, res) => {
      capturedBody = await readJson(req);

      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(JSON.stringify({ message: { role: "assistant", content: "Hel" } }) + "\n");
      res.write(JSON.stringify({ message: { role: "assistant", content: "lo" } }) + "\n");
      res.end(
        JSON.stringify({
          done: true,
          prompt_eval_count: 11,
          eval_count: 2,
        }) + "\n"
      );
    });

    const chunks: string[] = [];
    const result = await provider.streamChat(
      [
        { role: "user", content: "Hi", timestamp: 1 },
        { role: "model", content: "Hello earlier", timestamp: 2 },
        { role: "user", content: "Say hello again", timestamp: 3 },
      ],
      (chunk) => chunks.push(chunk)
    );

    expect(chunks).toEqual(["Hel", "lo"]);
    expect(result.message.content).toBe("Hello");
    expect(result.inputTokens).toBe(11);
    expect(result.outputTokens).toBe(2);
    expect(capturedBody).toMatchObject({
      stream: true,
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello earlier" },
        { role: "user", content: "Say hello again" },
      ],
    });
  });

  it("lists locally available Ollama models", async () => {
    const provider = await createTestProvider((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            { name: "llama3.2:latest" },
            { model: "qwen3:8b" },
          ],
        })
      );
    });

    await expect(provider.listModels()).resolves.toEqual([
      "llama3.2:latest",
      "qwen3:8b",
    ]);
  });

  it("surfaces Ollama backend errors", async () => {
    const provider = await createTestProvider((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "model failed to load" }));
    });

    await expect(
      provider.chat([{ role: "user", content: "Hello", timestamp: 1 }])
    ).rejects.toThrow("model failed to load");
  });

  async function createTestProvider(handler: RequestHandler): Promise<OllamaProvider> {
    server = http.createServer((req, res) => {
      void handler(req, res);
    });

    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    return new OllamaProvider(makeConfig(`http://127.0.0.1:${address.port}`));
  }
});

function makeConfig(baseUrl: string): AppConfig {
  return {
    provider: "ollama",
    apiKey: "",
    model: "qwen3:8b",
    logLevel: "silent",
    ollamaBaseUrl: baseUrl,
    voice: {
      language: "fr",
      sttProvider: "whisper-cpp",
      sttBinaryPath: "whisper-cli",
      sttModelPath: "./models/whisper/ggml-large-v3-turbo.bin",
      sttBaseUrl: "http://localhost:7862",
      sttTimeoutMs: 60000,
      ttsProvider: "qwen3-tts",
      ttsBaseUrl: "http://localhost:7861",
      ttsModel: "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
      ttsTimeoutMs: 120000,
      sampleRate: 16000,
      bargeIn: true,
      debugTranscript: true,
      promptsDir: "./prompts",
      vadThreshold: 0.018,
      vadSpeechMs: 120,
      vadSilenceMs: 500,
      vadMinThreshold: 0.002,
      bargeInSpeechMs: 250,
    },
  };
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });

    req.on("error", reject);
  });
}
