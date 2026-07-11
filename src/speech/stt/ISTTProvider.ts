import { STTAudioInput, STTSetupCheck, STTTranscriptionOptions, TranscriptEvent } from "./types";

export interface ISTTProvider {
  readonly name: string;
  checkSetup(): Promise<STTSetupCheck>;
  transcribe(audio: STTAudioInput, options?: STTTranscriptionOptions): AsyncIterable<TranscriptEvent>;
}
