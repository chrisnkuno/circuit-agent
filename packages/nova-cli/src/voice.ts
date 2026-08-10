import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type VoiceEnvironment = Record<string, string | undefined>;

export function recordingArgs(outputFile: string, platform = process.platform, device?: string): string[] {
  const head = ["-hide_banner", "-loglevel", "error", "-y"];
  const input = platform === "darwin"
    ? ["-f", "avfoundation", "-i", device?.trim() || ":0"]
    : platform === "win32"
      ? ["-f", "dshow", "-i", `audio=${device?.trim() || "default"}`]
      : ["-f", "pulse", "-i", device?.trim() || "default"];
  return [...head, ...input, "-ac", "1", "-ar", "16000", outputFile];
}

export type ActiveRecording = { file: string; stop(): Promise<void> };

/** Starts ffmpeg without a shell. Writing q stops it cleanly and finalizes the WAV header. */
export async function startRecording(
  environment: VoiceEnvironment,
  platform = process.platform,
  spawnImpl: typeof spawn = spawn,
): Promise<ActiveRecording> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nova-voice-"));
  const file = path.join(directory, "prompt.wav");
  const executable = environment.NOVA_FFMPEG_PATH?.trim() || "ffmpeg";
  const child = spawnImpl(executable, recordingArgs(file, platform, environment.VOICE_INPUT_DEVICE), {
    shell: false,
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  }) as unknown as ChildProcessWithoutNullStreams;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk).slice(0, 8_000); });
  await new Promise<void>((resolve, reject) => {
    const ready = setTimeout(resolve, 250);
    child.once("error", (error) => { clearTimeout(ready); reject(new Error(`Could not start microphone capture. Install ffmpeg or set NOVA_FFMPEG_PATH. ${error.message}`)); });
    child.once("exit", (code) => {
      if (code && code !== 0) { clearTimeout(ready); reject(new Error(`Microphone capture failed: ${stderr.trim() || `ffmpeg exited ${code}`}`)); }
    });
  }).catch(async (error) => { await fs.rm(directory, { recursive: true, force: true }); throw error; });

  return {
    file,
    stop: async () => {
      if (child.exitCode === null) child.stdin.write("q\n");
      const code = child.exitCode ?? await new Promise<number | null>((resolve) => child.once("close", resolve));
      if (code !== 0) throw new Error(`Microphone capture failed: ${stderr.trim() || `ffmpeg exited ${code}`}`);
    },
  };
}

export function transcriptionEndpoint(environment: VoiceEnvironment): string {
  if (environment.VOICE_TRANSCRIPTION_URL?.trim()) return environment.VOICE_TRANSCRIPTION_URL.trim();
  const base = environment.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  return `${base.replace(/\/$/, "")}/audio/transcriptions`;
}

export async function transcribeAudio(
  file: string,
  environment: VoiceEnvironment,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("Voice input needs OPENAI_API_KEY. Add it in nova settings or set it in your environment.");
  const bytes = await fs.readFile(file);
  if (bytes.byteLength === 0) throw new Error("The audio recording is empty.");
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("Audio must be 25 MB or smaller.");
  const form = new FormData();
  form.append("file", new Blob([bytes]), path.basename(file));
  form.append("model", environment.VOICE_MODEL?.trim() || "gpt-4o-mini-transcribe");
  form.append("response_format", "json");
  const response = await fetchImpl(transcriptionEndpoint(environment), {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Speech-to-text returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const result = await response.json() as { text?: unknown };
  if (typeof result.text !== "string" || !result.text.trim()) throw new Error("Speech-to-text returned no transcript.");
  return result.text.trim();
}

export async function removeRecording(file: string): Promise<void> {
  await fs.rm(path.dirname(file), { recursive: true, force: true });
}
