import Link from "next/link";
import { GyroscopeScene } from "@/components/gyroscope-scene";
import { CopyCommand } from "@/components/copy-command";

/**
 * Download / run-anywhere page for Circuit·Nova.
 * The Download button targets public/downloads/nova-setup-0.1.0-x64.msi —
 * drop the packaged Tauri installer there (apps/nova-desktop → npm run package:windows).
 */

export const metadata = {
  title: "Download — Circuit-Nova",
  description: "Download Nova Desktop for Windows or run Circuit·Nova from the CLI or the web.",
};

export default function DownloadPage() {
  return (
    <div className="kage-page download-page">
      <GyroscopeScene />
      <div className="kage-grain" aria-hidden="true" />
      <div className="kage-vignette" aria-hidden="true" />
      <main className="download-main">
        <Link className="download-back" href="/">← Circuit·Nova</Link>

        <p className="eyebrow"><span className="dot" aria-hidden="true" />Nova Desktop — run the agent on your machine</p>
        <h1 className="download-title">Your agent,<br />on your machine.</h1>
        <p className="download-lede">
          The same engine as the web — a native Windows app for the Nova coding agent.
          No subscriptions, no API keys, no hidden cost.
        </p>

        <div className="download-card">
          <div className="dl-row">
            <a className="download-big" href="/downloads/nova-setup-0.1.0-x64.msi">
              <svg width="15" height="15" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M6 1v7M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.2" /><path d="M2 11h8" stroke="currentColor" strokeWidth="1.2" /></svg>
              <span>Download for Windows<span>64-bit installer · .msi</span></span>
            </a>
            <a className="download-alt" href="#avx2">Older PC without AVX2? Learn more</a>
          </div>
          <div className="dl-meta">
            <span>Version 0.1.0</span>
            <span>Windows 10 / 11</span>
            <span>WebView2</span>
          </div>
          <p className="dl-staging">
            Installer not published yet — build it with <code>npm run package:windows</code> in
            <code> apps/nova-desktop</code> and drop the <code>.msi</code> into <code>public/downloads/</code>.
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
              Then run <code>nova "build me an app"</code>. Install command is a placeholder until the
              CLI package is published.
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
