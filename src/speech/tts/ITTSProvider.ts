import { TTSAudioResult, TTSEvent, TTSSynthesisOptions, TTSSetupCheck } from "./types";

export interface ITTSProvider {
  readonly name: string;
  checkSetup(): Promise<TTSSetupCheck>;
  synthesize(text: string, options?: TTSSynthesisOptions): Promise<TTSAudioResult>;
  synthesizeChunks(
    chunks: AsyncIterable<string> | Iterable<string>,
    options?: TTSSynthesisOptions
  ): AsyncIterable<TTSEvent>;
}
