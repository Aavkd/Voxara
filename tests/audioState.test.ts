import { AudioStateMachine } from "../src/audio/audioStateMachine";

describe("AudioStateMachine", () => {
  it("covers idle, listening, speaking, interrupted, and reset states", () => {
    const state = new AudioStateMachine();

    expect(state.state).toBe("idle");
    expect(state.transition("listen")).toBe("listening");
    expect(state.transition("speak")).toBe("speaking");
    expect(state.transition("interrupt")).toBe("interrupted");
    expect(state.transition("listen")).toBe("listening");
    expect(state.transition("stop")).toBe("idle");
  });

  it("enters error and only leaves it through reset", () => {
    const state = new AudioStateMachine();

    expect(state.transition("fail")).toBe("error");
    expect(state.transition("listen")).toBe("error");
    expect(state.transition("reset")).toBe("idle");
  });
});
