/**
 * Registers a DOM for `bun test`, so components can be rendered and driven rather than only their
 * extracted logic being checked.
 *
 * Loaded via `preload` in bunfig.toml, which runs before any test file — the registration has to
 * happen before React or Testing Library is imported anywhere, or they capture the absence of a
 * document and never let go of it.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://nova.test" });
