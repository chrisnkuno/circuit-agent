import { describe, expect, it } from "vitest";
import { credentialRequest, deployOffer, deployPlan, DEPLOY_PROVIDERS, detectWebApp } from "./deploy";

const manifest = (dependencies: Record<string, string>, scripts: Record<string, string> = {}) => ({
  packageJson: { dependencies, scripts },
});

describe("detecting a deployable web app", () => {
  it("recognises the frameworks people actually ship", () => {
    expect(detectWebApp(manifest({ next: "15" })).kind).toBe("next");
    expect(detectWebApp(manifest({ vite: "5", react: "19" })).kind).toBe("spa");
    expect(detectWebApp(manifest({ express: "4" })).kind).toBe("server");
    expect(detectWebApp({ files: ["index.html", "style.css"] }).kind).toBe("static");
  });

  /**
   * A Vite frontend and an Express API in one manifest is the single most common full-stack shape,
   * and classifying it as a static site deploys the half that has no data.
   */
  it("treats a project with both a frontend and a server as a server project", () => {
    const both = detectWebApp(manifest({ vite: "5", react: "19", express: "4" }));
    expect(both.kind).toBe("server");
    expect(both.recommended[0]).toBe("render");
  });

  it("recommends the provider that actually fits the shape", () => {
    // Render leads for long-running processes; Vercel leads for static output and Next.js.
    expect(detectWebApp(manifest({ fastify: "4" })).recommended[0]).toBe("render");
    expect(detectWebApp(manifest({ next: "15" })).recommended[0]).toBe("vercel");
    expect(detectWebApp(manifest({ vite: "5" })).recommended[0]).toBe("vercel");
    // ...but both are always offered, because either can host most things.
    expect(detectWebApp(manifest({ next: "15" })).recommended).toHaveLength(2);
  });

  it("finds the build script and output directory when the manifest names them", () => {
    const vite = detectWebApp(manifest({ vite: "5" }, { build: "vite build" }));
    expect(vite.buildScript).toBe("build");
    expect(vite.outputDirectory).toBe("dist");
    // Create React App and friends write to build/, not dist/.
    expect(detectWebApp(manifest({ "react-scripts": "5" }, { build: "react-scripts build" })).outputDirectory).toBe("build");
    // No build script means none is reported, rather than a guessed one that does not exist.
    expect(detectWebApp(manifest({ vite: "5" })).buildScript).toBeUndefined();
  });

  /**
   * The asymmetry is deliberate: a false positive costs one question the user says no to, while a
   * false negative silently withholds the capability and the user never learns it existed.
   */
  it("errs toward offering when the project is ambiguous", () => {
    const ambiguous = detectWebApp(manifest({ lodash: "4" }, { start: "node server.js" }));
    expect(ambiguous.isWebApp).toBe(true);
    expect(ambiguous.kind).toBe("unknown");
    expect(ambiguous.recommended.length).toBeGreaterThan(0);
  });

  it("still says no when there is genuinely nothing to serve", () => {
    expect(detectWebApp(manifest({ lodash: "4" }, { test: "vitest" })).isWebApp).toBe(false);
    expect(detectWebApp({}).isWebApp).toBe(false);
    expect(detectWebApp({ files: ["main.py", "README.md"] }).isWebApp).toBe(false);
  });

  it("explains itself in every case, so the agent can repeat the reason to the user", () => {
    for (const input of [manifest({ next: "15" }), manifest({ express: "4" }), manifest({ lodash: "4" }), { files: ["index.html"] }]) {
      expect(detectWebApp(input).reason.length).toBeGreaterThan(0);
    }
  });
});

describe("asking for a credential", () => {
  it("returns nothing when the token is already configured", () => {
    expect(credentialRequest("vercel", { VERCEL_TOKEN: "tok" })).toBeUndefined();
    expect(credentialRequest("render", { RENDER_API_KEY: "key" })).toBeUndefined();
  });

  it("treats an empty or whitespace variable as absent, not as configured", () => {
    // An exported-but-empty variable is the classic way a deploy fails deep inside a CLI instead
    // of at the check that was supposed to catch it.
    expect(credentialRequest("vercel", { VERCEL_TOKEN: "" })).toBeDefined();
    expect(credentialRequest("vercel", { VERCEL_TOKEN: "   " })).toBeDefined();
  });

  it("names the variable and where to create it, in a message a person can act on", () => {
    const request = credentialRequest("render", {})!;
    expect(request.variable).toBe("RENDER_API_KEY");
    expect(request.message).toContain("RENDER_API_KEY");
    expect(request.message).toContain("https://dashboard.render.com");
    // Both routes, because "set an environment variable" is not actionable advice to everyone.
    expect(request.message).toContain("/settings");
    // And it says plainly that nothing happened, so a stopped deploy is not read as a failed one.
    expect(request.message).toContain("Nothing has been deployed");
  });

  /**
   * The whole module reports token *presence* and never a value. A token that reaches a log or a
   * transcript outlives the session that leaked it.
   */
  it("never echoes the token value anywhere in what it returns", () => {
    const secret = "vercel_live_SECRET_VALUE_9f3a";
    expect(credentialRequest("vercel", { VERCEL_TOKEN: secret })).toBeUndefined();
    const request = credentialRequest("render", { RENDER_API_KEY: "", VERCEL_TOKEN: secret })!;
    expect(JSON.stringify(request)).not.toContain(secret);
  });

  it("refuses an unknown target rather than silently doing nothing", () => {
    expect(() => credentialRequest("fly" as never, {})).toThrow(/Unknown deploy target/);
  });
});

describe("the offer", () => {
  it("is a question, and says it will not act alone", () => {
    const offer = deployOffer(detectWebApp(manifest({ next: "15" })))!;
    expect(offer).toContain("Would you like me to deploy");
    expect(offer).toContain("Vercel");
    expect(offer).toContain("will not deploy anything without you saying so");
  });

  it("is absent for something that is not a web app, so nothing irrelevant is offered", () => {
    expect(deployOffer(detectWebApp(manifest({ lodash: "4" })))).toBeUndefined();
  });
});

describe("the deploy plan", () => {
  const next = detectWebApp(manifest({ next: "15" }, { build: "next build" }));

  it("shows the exact command, because 'deploy to Vercel' is not informed consent", () => {
    const plan = deployPlan("vercel", next, { production: true, directory: "web" });
    expect(plan.commands[0]).toContain("vercel@latest deploy web");
    expect(plan.commands[0]).toContain("--prod");
    expect(plan.commands[0]).toContain("--yes");
  });

  it("defaults to a preview rather than production", () => {
    expect(deployPlan("vercel", next).commands[0]).not.toContain("--prod");
  });

  /**
   * An argv is visible in `ps` to every process on the machine, and a command string is what gets
   * echoed into logs and transcripts. The token is referenced as a shell variable so the CLI reads
   * it from the environment it already reads it from.
   */
  it("references the token as an environment variable, never interpolating its value", () => {
    const plan = deployPlan("vercel", next, {});
    expect(plan.commands[0]).toContain('"$VERCEL_TOKEN"');
  });

  it("warns when the target does not fit the project, rather than failing halfway through", () => {
    const server = detectWebApp(manifest({ express: "4" }));
    const notes = deployPlan("vercel", server, {}).notes.join(" ");
    expect(notes).toContain("does not host");
    expect(notes).toContain("Render");
  });

  it("says up front that Render needs a blueprint, instead of discovering it in a 404", () => {
    const notes = deployPlan("render", next, {}).notes.join(" ");
    expect(notes).toContain("render.yaml");
    expect(notes).toContain("show it to you before deploying");
  });

  it("tells Render to publish a static build as a static site, with the right directory", () => {
    const vite = detectWebApp(manifest({ vite: "5" }, { build: "vite build" }));
    expect(deployPlan("render", vite, {}).notes.join(" ")).toContain('publishing "dist"');
  });

  it("keeps every provider's metadata complete, since the messages are built from it", () => {
    for (const provider of Object.values(DEPLOY_PROVIDERS)) {
      expect(provider.tokenVariable).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(provider.tokenUrl.startsWith("https://")).toBe(true);
      expect(provider.suitedFor.length).toBeGreaterThan(0);
    }
  });
});
