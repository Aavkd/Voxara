export type ScreenTarget = "screen" | "window" | "browser_tab";

export interface ScreenCaptureRequest {
  target: Exclude<ScreenTarget, "browser_tab">;
  windowTitle?: string;
  maxEdge?: number;
}

export interface ScreenImageResult {
  kind: "image";
  mimeType: "image/png";
  base64: string;
  note?: string;
}

export interface ControlJournalEntry {
  timestamp: string;
  sessionId: string;
  lane: "fast" | "pilot";
  intent: string;
  target: string;
  policyDecision: "allowed";
  outcome: "success" | "error";
  error?: string;
  artifact?: string;
}
