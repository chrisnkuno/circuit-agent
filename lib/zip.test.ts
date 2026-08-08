import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { archiveFilename, archivePathForArtifact, createZip, crc32 } from "./zip";

const encoder = new TextEncoder();
const fixedDate = new Date(2026, 0, 2, 3, 4, 6);

/** Reads the archive back the way an unzip tool does: central directory first, then each entry. */
function readZip(archive: Uint8Array): Array<{ path: string; text: string; method: number }> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const count = view.getUint16(archive.byteLength - 22 + 10, true);
  let at = view.getUint32(archive.byteLength - 22 + 16, true);
  const decoder = new TextDecoder();
  const entries: Array<{ path: string; text: string; method: number }> = [];

  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const localOffset = view.getUint32(at + 42, true);
    const path = decoder.decode(archive.subarray(at + 46, at + 46 + nameLength));

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const bodyAt = localOffset + 30 + localNameLength + localExtraLength;
    const body = archive.subarray(bodyAt, bodyAt + compressedSize);
    const raw = method === 8 ? new Uint8Array(inflateRawSync(Buffer.from(body))) : body;
    expect(crc32(raw)).toBe(crc);

    entries.push({ path, text: decoder.decode(raw), method });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return entries;
}

describe("createZip", () => {
  it("produces an archive a standard unzip reads back byte for byte", async () => {
    const archive = await createZip([
      { path: "wander/REPORT.html", data: encoder.encode("<h1>Findings</h1>"), modified: fixedDate },
      { path: "src/main.py", data: encoder.encode("print('hello')\n"), modified: fixedDate },
    ]);
    expect(readZip(archive).map((entry) => [entry.path, entry.text])).toEqual([
      ["wander/REPORT.html", "<h1>Findings</h1>"],
      ["src/main.py", "print('hello')\n"],
    ]);
  });

  it("compresses text that benefits and stores what does not, keeping both readable", async () => {
    const archive = await createZip([
      { path: "big.txt", data: encoder.encode("the same sentence over and over. ".repeat(200)), modified: fixedDate },
      { path: "tiny.txt", data: encoder.encode("hi"), modified: fixedDate },
    ]);
    const entries = readZip(archive);
    expect(entries[0].method).toBe(8);
    expect(entries[0].text).toContain("the same sentence over and over.");
    expect(entries[1].method).toBe(0);
    expect(entries[1].text).toBe("hi");
    // The whole point of compressing: the archive is far smaller than the bytes it carries.
    expect(archive.byteLength).toBeLessThan(6_600 / 4);
  });

  it("keeps same-named files from different steps instead of dropping one", async () => {
    const archive = await createZip([
      { path: "notes.md", data: encoder.encode("first"), modified: fixedDate },
      { path: "notes.md", data: encoder.encode("second"), modified: fixedDate },
      { path: "Makefile", data: encoder.encode("all:"), modified: fixedDate },
      { path: "Makefile", data: encoder.encode("clean:"), modified: fixedDate },
    ]);
    expect(readZip(archive).map((entry) => entry.path)).toEqual(["notes.md", "notes (2).md", "Makefile", "Makefile (2)"]);
  });

  it("writes a valid empty archive rather than failing on a task with nothing to download", async () => {
    const archive = await createZip([]);
    expect(archive.byteLength).toBe(22);
    expect(readZip(archive)).toEqual([]);
  });
});

describe("archive naming", () => {
  it("keeps workspace files at their sandbox path and files evidence under logs/", () => {
    expect(archivePathForArtifact({ kind: "workspace_file", path: "wander/HYPOTHESES.md", stepTitle: null, id: "a" })).toBe("wander/HYPOTHESES.md");
    expect(archivePathForArtifact({ kind: "workspace_file", path: "/src/main.py", stepTitle: null, id: "a" })).toBe("src/main.py");
    expect(archivePathForArtifact({ kind: "model_plan", path: null, stepTitle: "Build and verify", id: "a" })).toBe("logs/build-and-verify-model_plan.json");
    expect(archivePathForArtifact({ kind: "command_log", path: null, stepTitle: null, id: "a" })).toBe("logs/command-log-command_log.txt");
  });

  it("slugs the task title into a filesystem-safe archive name", () => {
    // Clipped at 48 characters, mid-word if need be — a name, not a description.
    expect(archiveFilename("[Wander] Topic: how GPS relativity corrections work")).toBe("wander-topic-how-gps-relativity-corrections-wor-work.zip");
    expect(archiveFilename("!!!")).toBe("task-work.zip");
  });
});
