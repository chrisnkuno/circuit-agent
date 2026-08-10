import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordingArgs, transcribeAudio, transcriptionEndpoint } from "./voice";

describe("voice input", () => {
  it("selects native ffmpeg capture inputs on Windows, macOS and Linux", () => {
    expect(recordingArgs("out.wav", "win32")).toContain("audio=default");
    expect(recordingArgs("out.wav", "darwin")).toContain("avfoundation");
    expect(recordingArgs("out.wav", "linux")).toContain("pulse");
  });

  it("uses an explicit endpoint or derives one from the OpenAI-compatible base URL", () => {
    expect(transcriptionEndpoint({ OPENAI_BASE_URL: "https://example.com/v1/" })).toBe("https://example.com/v1/audio/transcriptions");
    expect(transcriptionEndpoint({ VOICE_TRANSCRIPTION_URL: "https://speech.example.com/transcribe" })).toBe("https://speech.example.com/transcribe");
  });

  it("uploads audio and returns clean transcript text", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-voice-test-"));
    const file = path.join(root, "voice.wav");
    await fs.writeFile(file, "audio");
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer key");
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({ text: "  fix the tests  " }), { status: 200 });
    };
    await expect(transcribeAudio(file, { OPENAI_API_KEY: "key" }, fetchImpl)).resolves.toBe("fix the tests");
    await fs.rm(root, { recursive: true, force: true });
  });
});
