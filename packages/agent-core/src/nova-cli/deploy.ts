/**
 * Deploying what was just built — Vercel and Render, offered rather than assumed.
 *
 * A web app that only ever ran on localhost is half-finished, and the gap between "it works here"
 * and "it works where someone else can open it" is where most of the real bugs live: the build
 * script that only passes with dev dependencies present, the API route that assumed a filesystem,
 * the environment variable that was only ever in a local `.env`. Offering the deploy is how those
 * surface while the agent still has the context to fix them.
 *
 * Three rules shape everything here, and all three are about not doing something surprising with
 * someone else's account:
 *
 * - **Detection decides whether to offer, never whether to go.** `detectWebApp` reads a manifest
 *   and says "this looks deployable"; it does not deploy. The offer is a sentence to a human.
 * - **A missing credential is a question, not a failure.** `credentialRequest` produces the exact
 *   thing to ask for and where to get it, so an agent without a token stops and asks rather than
 *   flailing through `vercel login` prompts it cannot answer, or reporting a wall of CLI output.
 * - **Nothing here ever reads or echoes a token value.** It reports only whether a variable is set.
 *   A deploy log with a bearer token in it is a credential leak that outlives the session.
 */

export type DeployTarget = "vercel" | "render";

export type DeployProvider = {
  id: DeployTarget;
  label: string;
  /** The environment variable holding the API token. Its *presence* is checked; never its value. */
  tokenVariable: string;
  /** Where a human goes to create that token. Printed when asking, so nobody has to search. */
  tokenUrl: string;
  /** What this provider is actually good at, so the agent can choose rather than guess. */
  suitedFor: string;
};

export const DEPLOY_PROVIDERS: Record<DeployTarget, DeployProvider> = {
  vercel: {
    id: "vercel",
    label: "Vercel",
    tokenVariable: "VERCEL_TOKEN",
    tokenUrl: "https://vercel.com/account/tokens",
    suitedFor: "static sites, single-page apps, and Next.js — anything that builds to static output or serverless functions",
  },
  render: {
    id: "render",
    label: "Render",
    tokenVariable: "RENDER_API_KEY",
    tokenUrl: "https://dashboard.render.com/u/settings#api-keys",
    suitedFor: "long-running servers, background workers, containers and anything needing a managed database",
  },
};

export type WebAppKind = "static" | "spa" | "next" | "server" | "unknown";

export type WebAppDetection = {
  isWebApp: boolean;
  kind: WebAppKind;
  /** Why it was classified this way, in the terms the agent should repeat to the user. */
  reason: string;
  /** Best-first. Both providers can host most things; the order encodes which fits better. */
  recommended: DeployTarget[];
  /** The script that produces the deployable output, when the manifest names one. */
  buildScript?: string;
  /** Where that script writes to, when it can be inferred from the framework. */
  outputDirectory?: string;
};

const SPA_FRAMEWORKS = ["vite", "react-scripts", "parcel", "@angular/cli", "vue", "svelte", "solid-js", "preact"];
const SERVER_FRAMEWORKS = ["express", "fastify", "koa", "hapi", "nest", "@nestjs/core", "hono", "socket.io", "ws"];

/**
 * Classifies a project from its manifest and file list.
 *
 * Deliberately conservative in one direction only. A false "this is a web app" costs a question
 * the user answers with "no"; a false "this is not" silently withholds the offer, and the user
 * never learns the capability existed. So ambiguous cases resolve to `unknown` *and still offer* —
 * `isWebApp` stays true — rather than to a confident no.
 *
 * Server detection is checked before SPA because the two co-occur constantly: a Vite frontend with
 * an Express API in the same manifest is a server project that happens to build a frontend, and
 * deploying it as a static site drops the half that holds the data.
 */
export function detectWebApp(input: {
  packageJson?: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
  files?: readonly string[];
}): WebAppDetection {
  const manifest = input.packageJson;
  const files = input.files ?? [];
  const dependencies = { ...(manifest?.dependencies ?? {}), ...(manifest?.devDependencies ?? {}) };
  const names = Object.keys(dependencies);
  const scripts = manifest?.scripts ?? {};
  const has = (candidates: readonly string[]) => candidates.some((candidate) => names.includes(candidate));

  if (!manifest) {
    // No manifest at all: a plain `index.html` is still a deployable site, and is in fact the
    // easiest possible deploy — no build step, just upload.
    const hasHtml = files.some((file) => /(^|\/)index\.html$/i.test(file));
    return hasHtml
      ? { isWebApp: true, kind: "static", reason: "an index.html with no build manifest — a static site", recommended: ["vercel", "render"] }
      : { isWebApp: false, kind: "unknown", reason: "no package.json and no index.html", recommended: [] };
  }

  if (names.includes("next")) {
    return {
      isWebApp: true,
      kind: "next",
      reason: "Next.js in the dependencies",
      recommended: ["vercel", "render"],
      ...(scripts.build ? { buildScript: "build" } : {}),
      outputDirectory: ".next",
    };
  }

  if (has(SERVER_FRAMEWORKS)) {
    return {
      isWebApp: true,
      kind: "server",
      // Render leads here: a long-running process is what it is built for, and Vercel's serverless
      // model requires restructuring an Express app rather than deploying it.
      reason: `a long-running server framework (${SERVER_FRAMEWORKS.filter((name) => names.includes(name)).join(", ")})`,
      recommended: ["render", "vercel"],
      ...(scripts.build ? { buildScript: "build" } : {}),
    };
  }

  if (has(SPA_FRAMEWORKS)) {
    const vite = names.includes("vite");
    return {
      isWebApp: true,
      kind: "spa",
      reason: `a browser app built with ${SPA_FRAMEWORKS.filter((name) => names.includes(name)).join(", ")}`,
      recommended: ["vercel", "render"],
      ...(scripts.build ? { buildScript: "build" } : {}),
      outputDirectory: vite ? "dist" : "build",
    };
  }

  const hasHtml = files.some((file) => /(^|\/)index\.html$/i.test(file));
  if (hasHtml || scripts.start || scripts.dev) {
    return {
      isWebApp: true,
      kind: "unknown",
      reason: hasHtml ? "an index.html in the project" : "a start/dev script, so something is meant to be served",
      recommended: ["vercel", "render"],
      ...(scripts.build ? { buildScript: "build" } : {}),
    };
  }

  return { isWebApp: false, kind: "unknown", reason: "no web framework, index.html, or start script", recommended: [] };
}

export type CredentialRequest = {
  target: DeployTarget;
  variable: string;
  url: string;
  /** Ready to show to a human: what is needed, where to get it, and how to supply it. */
  message: string;
};

/**
 * What to ask for when a deploy has no credential, phrased for a person rather than a log.
 *
 * Returns `undefined` when the token is already present, so the caller's happy path is a single
 * falsy check. The message names the variable, links the page that issues it, and gives both ways
 * to supply it — because "set an environment variable" is not actionable advice to everyone, and
 * an agent that stops with only that has stopped for no reason the user can act on.
 */
export function credentialRequest(target: DeployTarget, environment: Record<string, string | undefined>): CredentialRequest | undefined {
  const provider = DEPLOY_PROVIDERS[target];
  if (!provider) throw new Error(`Unknown deploy target: ${target}`);
  // Presence only — the value is never read, compared, or logged anywhere in this module.
  if ((environment[provider.tokenVariable] ?? "").trim()) return undefined;
  return {
    target,
    variable: provider.tokenVariable,
    url: provider.tokenUrl,
    message: [
      `Deploying to ${provider.label} needs an API token, and none is configured.`,
      `Create one at ${provider.tokenUrl}, then either set ${provider.tokenVariable} in your environment or add it through /settings.`,
      "Nothing has been deployed and nothing has been sent to the provider.",
    ].join(" "),
  };
}

/**
 * The sentence an agent should say when it has built something deployable.
 *
 * A question, always. Deploying publishes to the internet under the user's account and their name,
 * which is not a step to infer from "they asked me to build a website" — plenty of people build
 * things they have no intention of publishing, and an agent that guessed wrong has put someone's
 * half-finished work at a public URL.
 */
export function deployOffer(detection: WebAppDetection): string | undefined {
  if (!detection.isWebApp) return undefined;
  const [first, second] = detection.recommended;
  const providers = [first, second].filter(Boolean).map((target) => DEPLOY_PROVIDERS[target as DeployTarget]);
  if (providers.length === 0) return undefined;
  const fit = `${providers[0].label} suits ${providers[0].suitedFor}.`;
  return [
    `This is ${detection.reason}, so it can be deployed.`,
    `Would you like me to deploy it to ${providers.map((provider) => provider.label).join(" or ")}? ${fit}`,
    "I will not deploy anything without you saying so.",
  ].join(" ");
}

/**
 * The exact commands a deploy would run, as text, before any of them runs.
 *
 * Built as a plan rather than executed directly so the approval prompt can show precisely what is
 * about to happen. "Deploy to Vercel" is not informed consent; `vercel deploy --prod --yes` in a
 * named directory is.
 *
 * The token is passed to the CLI through the environment it already reads, never interpolated into
 * a command string — an argv is visible in `ps` output to every other process on the machine, and
 * a command string is what gets echoed into logs and transcripts.
 */
export function deployPlan(target: DeployTarget, detection: WebAppDetection, options: { production?: boolean; directory?: string } = {}): { commands: string[]; notes: string[] } {
  const directory = options.directory ?? ".";
  const production = options.production ?? false;
  const notes: string[] = [];

  if (target === "vercel") {
    const commands = [`npx --yes vercel@latest deploy ${directory} ${production ? "--prod " : ""}--yes --token "$VERCEL_TOKEN"`];
    if (detection.kind === "server") {
      notes.push("This project runs a long-lived server, which Vercel does not host directly — it would need restructuring into serverless functions. Render is the closer fit.");
    }
    if (detection.buildScript) notes.push(`Vercel will run the "${detection.buildScript}" script itself; no local build is required first.`);
    return { commands, notes };
  }

  // Render's CLI is deploy-from-config, so the honest answer for a first deploy is that a
  // render.yaml has to exist. Saying so up front beats a failed deploy that reports a 404.
  const commands = [`npx --yes render-cli@latest deploy --config render.yaml`];
  notes.push("Render deploys from a render.yaml blueprint. If the project has none, I will write one describing the service and show it to you before deploying.");
  if (detection.kind === "spa" || detection.kind === "static") {
    notes.push(`This is a static build, so the blueprint should declare a static site${detection.outputDirectory ? ` publishing "${detection.outputDirectory}"` : ""} rather than a web service.`);
  }
  return { commands, notes };
}
