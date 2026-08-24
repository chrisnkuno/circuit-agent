/**
 * A minimal ZIP writer, so a run's produced work can leave the app as one folder.
 *
 * Hand-rolled rather than pulled in as a dependency: the archive here is a flat list of small text
 * files with no encryption, no zip64, and no streaming, which is a few hundred bytes of header
 * writing. Compression is the platform's own `CompressionStream` — every browser this app targets
 * and every Node the tests run on has it — so nothing ships a deflate implementation either.
 *
 * Entries whose compression would not help (or where the platform lacks `CompressionStream`) are
 * stored, which is a normal, universally readable ZIP; the archive is never invalid, only larger.
 */

export type ZipEntry = {
  /** Path inside the archive, using forward slashes. Directories are implied by the path. */
  path: string;
  data: Uint8Array;
  /** Defaults to now; fixed values keep archives byte-identical across runs in tests. */
  modified?: Date;
};

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** Bit 11: names and comments are UTF-8, which is the only thing this writer emits. */
const FLAG_UTF8 = 0x0800;
const VERSION_NEEDED = 20;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time, which is what the format stores — two 16-bit fields, seconds at 2s resolution. */
function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | undefined> {
  const Compression = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!Compression || data.byteLength === 0) return undefined;
  try {
    const stream = new Response(new Blob([data as BlobPart]).stream().pipeThrough(new Compression("deflate-raw")));
    const compressed = new Uint8Array(await stream.arrayBuffer());
    // A file that grows under compression is stored instead; the format allows either.
    return compressed.byteLength < data.byteLength ? compressed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the archive. Duplicate paths are kept distinct (`name (2).txt`) rather than silently
 * collapsed — two steps can each write a file of the same name, and dropping one would quietly
 * hand back less work than the run produced.
 */
export async function createZip(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const seen = new Map<string, number>();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const taken = seen.get(entry.path) ?? 0;
    seen.set(entry.path, taken + 1);
    const path = taken === 0 ? entry.path : uniquePath(entry.path, taken);

    const name = encoder.encode(path);
    const compressed = await deflateRaw(entry.data);
    const body = compressed ?? entry.data;
    const method = compressed ? METHOD_DEFLATE : METHOD_STORE;
    const { time, date } = dosDateTime(entry.modified ?? new Date());
    const checksum = crc32(entry.data);

    const local = new Uint8Array(30 + name.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
    localView.setUint16(4, VERSION_NEEDED, true);
    localView.setUint16(6, FLAG_UTF8, true);
    localView.setUint16(8, method, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, body.byteLength, true);
    localView.setUint32(22, entry.data.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
    centralView.setUint16(4, VERSION_NEEDED, true);
    centralView.setUint16(6, VERSION_NEEDED, true);
    centralView.setUint16(8, FLAG_UTF8, true);
    centralView.setUint16(10, method, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, body.byteLength, true);
    centralView.setUint32(24, entry.data.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.byteLength + body.byteLength;
  }

  const centralSize = centrals.reduce((total, part) => total + part.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return concat([...locals, ...centrals, end]);
}

function uniquePath(path: string, taken: number): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot <= slash + 1) return `${path} (${taken + 1})`;
  return `${path.slice(0, dot)} (${taken + 1})${path.slice(dot)}`;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.byteLength;
  }
  return result;
}

/**
 * Where an artifact belongs inside the archive.
 *
 * Workspace files keep the path they had in the sandbox, so the download opens as the folder the
 * run actually worked in. Everything else is evidence about how that folder came to be, and is
 * filed under `logs/` instead of being mixed in with the work.
 */
export function archivePathForArtifact(artifact: { kind: string; path: string | null; stepTitle: string | null; id: string }): string {
  if (artifact.kind === "workspace_file" && artifact.path) return artifact.path.replace(/^\/+/, "");
  const label = slugify(artifact.stepTitle ?? artifact.kind, 48) || "step";
  const extension = artifact.kind === "model_plan" ? "json" : artifact.kind === "patch" ? "diff" : "txt";
  return `logs/${label}-${artifact.kind}.${extension}`;
}

/** Trailing hyphens are stripped after clipping, not before, so a cut mid-word does not dangle. */
function slugify(text: string, maxLength: number): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, maxLength).replace(/^-+|-+$/g, "");
}

/** Filesystem-safe archive name for a task, e.g. `wander-gps-relativity-work.zip`. */
export function archiveFilename(title: string): string {
  const slug = slugify(title, 48) || "task";
  return `${slug}-work.zip`;
}
