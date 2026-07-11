import { AudioLifecycleState } from "./types";

export type AudioStateEvent =
  | "listen"
  | "speak"
  | "interrupt"
  | "stop"
  | "reset"
  | "fail";

export class AudioStateMachine {
  private current: AudioLifecycleState = "idle";

  get state(): AudioLifecycleState {
    return this.current;
  }

  transition(event: AudioStateEvent): AudioLifecycleState {
    if (event === "fail") {
      this.current = "error";
      return this.current;
    }

    if (event === "reset") {
      this.current = "idle";
      return this.current;
    }

    switch (this.current) {
      case "idle":
        if (event === "listen") this.current = "listening";
        if (event === "speak") this.current = "speaking";
        break;
      case "listening":
        if (event === "speak") this.current = "speaking";
        if (event === "stop") this.current = "idle";
        break;
      case "speaking":
        if (event === "interrupt") this.current = "interrupted";
        if (event === "stop") this.current = "idle";
        break;
      case "interrupted":
        if (event === "listen") this.current = "listening";
        if (event === "stop") this.current = "idle";
        break;
      case "error":
        break;
    }

    return this.current;
  }
}
