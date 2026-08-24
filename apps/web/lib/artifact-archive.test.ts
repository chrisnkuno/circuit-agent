import { describe, expect, it, vi } from "vitest";
import { inflateRawSync } from "node:zlib";
import { buildArtifactArchive, type ArchivableArtifact } from "./artifact-archive";

const decoder = new TextDecoder();

function artifact(overrides: Partial<ArchivableArtifact> & { id: string }): ArchivableArtifact {
  return { kind: "workspace_file", path: `${overrides.id}.py`, stepTitle: "Build and verify", createdAt: 1_700_000_000_000, url: `https://storage/${overrides.id}`, ...overrides };
}

/** Reads entry names out of the central directory, which is what an unzip tool trusts. */
function pathsIn(archive: Uint8Array): string[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const count = view.getUint16(archive.byteLength - 12, true);
  let at = view.getUint32(archive.byteLength - 6, true);
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const nameLength = view.getUint16(at + 28, true);
    paths.push(decoder.decode(archive.subarray(at + 46, at + 46 + nameLength)));
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return paths;
}

function respondWith(bodies: Record<string, string>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const body = bodies[String(input)];
    if (body === undefined) return new Response("missing", { status: 404 });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("buildArtifactArchive", () => {
  it("packs every artifact into one archive, sorted and named for the work", async () => {
    const archive = await buildArtifactArchive(
      [
        artifact({ id: "zebra" }),
        artifact({ id: "alpha" }),
        artifact({ id: "plan", kind: "model_plan", path: null }),
      ],
      { fetchImpl: respondWith({ "https://storage/zebra": "z", "https://storage/alpha": "a", "https://storage/plan": "{}" }) },
    );

    expect(pathsIn(archive.bytes)).toEqual(["alpha.py", "logs/build-and-verify-model_plan.json", "zebra.py"]);
    expect(archive.filename).toBe("produced-work.zip");
    expect(archive.fileCount).toBe(3);
  });

  it("names a Wander archive for the lab it holds", async () => {
    const archive = await buildArtifactArchive([artifact({ id: "report", path: "wander/REPORT.html" })], {
      fetchImpl: respondWith({ "https://storage/report": "<h1>Findings</h1>" }),
    });
    expect(archive.filename).toBe("wander-lab-work.zip");
  });

  it("reports rows whose content was never stored instead of pretending the archive is complete", async () => {
    const archive = await buildArtifactArchive([artifact({ id: "kept" }), artifact({ id: "lost", url: null, path: "gone.py" })], {
      fetchImpl: respondWith({ "https://storage/kept": "kept" }),
    });
    expect(archive.fileCount).toBe(1);
    expect(archive.skipped).toEqual(["gone.py"]);
  });

  it("fails the whole archive when a file cannot be fetched, rather than shipping a partial one", async () => {
    await expect(
      buildArtifactArchive([artifact({ id: "ok" }), artifact({ id: "broken", path: "broken.py" })], {
        fetchImpl: respondWith({ "https://storage/ok": "fine" }),
      }),
    ).rejects.toThrow("broken.py could not be read (404)");
  });

  it("reports progress once per file and keeps content intact through compression", async () => {
    const seen: Array<[number, number]> = [];
    const body = "print('x')\n".repeat(80);
    const archive = await buildArtifactArchive([artifact({ id: "a" }), artifact({ id: "b" })], {
      fetchImpl: respondWith({ "https://storage/a": body, "https://storage/b": body }),
      concurrency: 1,
      onProgress: (done, total) => seen.push([done, total]),
    });

    expect(seen).toEqual([[1, 2], [2, 2]]);
    const view = new DataView(archive.bytes.buffer, archive.bytes.byteOffset, archive.bytes.byteLength);
    const firstBodyAt = 30 + view.getUint16(26, true);
    const stored = archive.bytes.subarray(firstBodyAt, firstBodyAt + view.getUint32(18, true));
    expect(decoder.decode(inflateRawSync(Buffer.from(stored)))).toBe(body);
  });
});
