import { parseWindowsDshowAudioDevices } from "../src/audio/microphone";

describe("parseWindowsDshowAudioDevices", () => {
  it("extracts unique DirectShow audio device names", () => {
    const output = `
[dshow @ 000001] "Integrated Camera" (video)
[dshow @ 000001] "Microphone Array (Realtek Audio)" (audio)
[dshow @ 000001]   Alternative name "@device_cm_{abc}"
[dshow @ 000001] "Microphone Array (Realtek Audio)" (audio)
[dshow @ 000001] "Headset Microphone" (audio)
`;

    expect(parseWindowsDshowAudioDevices(output)).toEqual([
      {
        id: "Microphone Array (Realtek Audio)",
        name: "Microphone Array (Realtek Audio)",
        isDefault: false,
      },
      {
        id: "Headset Microphone",
        name: "Headset Microphone",
        isDefault: false,
      },
    ]);
  });
});
