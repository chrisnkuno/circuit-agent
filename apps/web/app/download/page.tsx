import Link from "next/link";
import { GyroscopeScene } from "@/components/gyroscope-scene";
import { CopyCommand } from "@/components/copy-command";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * Download / run-anywhere page for Circuit·Nova.
 *
 * The desktop installer is built and published from its own repository — chrisnkuno/nova-desktop,
 * which is where the Tauri app lives since it was split out of this monorepo. This page resolves
 * that repository's latest release so the primary CTA always points at the newest installer, and
 * it must keep pointing there: releases are no longer cut from this repo's tags.
 */

export const metadata = {
  title: "Download — Circuit-Nova",
  description: "Download Nova Desktop for Windows or run Circuit·Nova from the CLI or the web.",
};

const OWNER = "chrisnkuno";
const REPO = "nova-desktop";

export const revalidate = 600;

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

type LatestRelease = {
  tag_name: string;
  html_url: string;
  published_at: string | null;
  assets: ReleaseAsset[];
};

function formatBytes(bytes: number): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

function pickInstaller(release: LatestRelease): ReleaseAsset | null {
  const setup =
    release.assets.find((a) => a.name.endsWith("-setup.exe")) ||
    release.assets.find((a) => a.name.endsWith(".exe")) ||
    release.assets.find((a) => a.name.endsWith(".msi"));
  return setup ?? null;
}

async function getLatestRelease(): Promise<LatestRelease | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "circuit-agent" },
    });
    if (!res.ok) return null;
    return (await res.json()) as LatestRelease;
  } catch {
    return null;
  }
}

export default async function DownloadPage() {
  const release = await getLatestRelease();
  const installer = release ? pickInstaller(release) : null;
  const fallbackUrl = `https://github.com/${OWNER}/${REPO}/releases/latest`;
  const downloadUrl = installer?.browser_download_url ?? (release?.html_url ?? fallbackUrl);
  const version = release?.tag_name?.replace(/^v/, "") ?? null;

  return (
    <div className="kage-page download-page">
      <GyroscopeScene />
      <div className="kage-grain" aria-hidden="true" />
      <div className="kage-vignette" aria-hidden="true" />
      <main className="download-main">
        <div className="download-back-row">
          <Link className="download-back" href="/">← Circuit·Nova</Link>
          <ThemeToggle />
        </div>

        <p className="eyebrow"><span className="dot" aria-hidden="true" />Nova Desktop — run the agent on your machine</p>
        <h1 className="download-title">Your agent,<br />on your machine.</h1>
        <p className="download-lede">
          The same engine as the web — a native Windows app for the Nova coding agent.
          No subscriptions, no API keys, no hidden cost.
        </p>

        <div className="download-card">
          <div className="dl-row">
            <a className="download-big" href={downloadUrl}>
              <svg width="15" height="15" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M6 1v7M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.2" /><path d="M2 11h8" stroke="currentColor" strokeWidth="1.2" /></svg>
              <span>Download for Windows<span>{installer?.name ?? "64-bit installer"} · {installer ? formatBytes(installer.size) : "~60 MB"}</span></span>
            </a>
            <a className="download-alt" href="#avx2">Older PC without AVX2? Learn more</a>
          </div>
          <div className="dl-meta">
            <span>{version ? `Version ${version}` : "Latest release"}</span>
            <span>Windows 10 / 11</span>
            <span>WebView2</span>
          </div>
          <p className="dl-staging">
            Self-contained app — no Node or extra runtimes needed. Installed copies update
            themselves automatically from new GitHub releases.
          </p>
        </div>

        <div className="download-sections">
          <section className="dl-sec">
            <h2>CLI</h2>
            <p>Drive the agent from your own terminal — same sessions, same approvals:</p>
            <div className="dl-code">
              <CopyCommand command="npm install -g @circuit-nova/nova-cli" />
            </div>
            <p className="dl-note">
              Then run <code>nova &quot;build me an app&quot;</code>. Needs Node 22.5 or newer on
              Windows, macOS or Linux.
            </p>
          </section>

          <section className="dl-sec" id="avx2">
            <h2>Older PC without AVX2?</h2>
            <p>
              The native desktop binary requires an AVX2-capable CPU. Older machines can still run
              the full agent — the web app works in any modern browser, with quotes
              and approval gates all intact.
            </p>
            <Link className="dl-link" href="/">Use the web app →</Link>
          </section>
        </div>
      </main>
    </div>
  );
}