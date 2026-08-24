/** One-time offline key setup. The private key is written, never printed. */
import { generateKeyPairSync } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const flag = process.argv.indexOf("--private-out");
const output = flag >= 0 ? process.argv[flag + 1] : undefined;
if (!output) throw new Error("Usage: bun run defender:feed-key --private-out /secure/path/defender-feed-key.pem");
const destination = path.resolve(output);
await fs.mkdir(path.dirname(destination), { recursive: true });
const pair = generateKeyPairSync("ed25519");
const privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const publicDer = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
try {
  await fs.writeFile(destination, privatePem, { encoding: "utf8", mode: 0o600, flag: "wx" });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Refusing to overwrite existing key: ${destination}`);
  throw error;
}
console.log(`Private key written with owner-only permissions: ${destination}`);
console.log("Store its contents as DEFENDER_BRAIN_SIGNING_KEY in the central host; never commit it.");
console.log(`Pin this SPKI public key in OFFICIAL_DEFENDER_FEED_KEYS: ${publicDer}`);
