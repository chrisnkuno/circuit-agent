import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    // The workspace root, not this app. Turbopack resolves modules — `next` itself included —
    // from here, and in a monorepo that has to be the directory holding the lockfile and the
    // hoisted node_modules. It was `__dirname` while this app lived at the repository root, which
    // was the same directory; since the move it is two levels up, and pointing it at the app makes
    // Turbopack refuse to compile `app/` because it cannot find `next/package.json`.
    root: path.resolve(__dirname, "../.."),
  },
};

export default nextConfig;
