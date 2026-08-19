import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { controlLabel, resolveControlLanguage } from "./i18n";
import { SUPPORTED_COUNTRIES, currencyForCountry, normalizeCountryCode } from "./local-currency";
import { isCurrency } from "@circuit-nova/nova-core/money";

/** A value that can be picked from a list, with the human name shown beside the stored code. */
export type SettingChoice = { value: string; label: string };

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", zh: "中文", hi: "हिन्दी", es: "Español", fr: "Français",
  ar: "العربية", bn: "বাংলা", pt: "Português", ru: "Русский", ur: "اردو",
};

const COUNTRY_NAMES: Record<string, string> = {
  RW: "Rwanda", EG: "Egypt", KE: "Kenya", UG: "Uganda", TZ: "Tanzania", NG: "Nigeria", ZA: "South Africa",
  GH: "Ghana", ET: "Ethiopia", US: "United States", CA: "Canada", GB: "United Kingdom", FR: "France",
  DE: "Germany", ES: "Spain", IT: "Italy", NL: "Netherlands", BE: "Belgium", CH: "Switzerland",
  SE: "Sweden", NO: "Norway", DK: "Denmark", PL: "Poland", CZ: "Czechia", TR: "Türkiye", AE: "United Arab Emirates",
  SA: "Saudi Arabia", IL: "Israel", IN: "India", CN: "China", JP: "Japan", SG: "Singapore",
  AU: "Australia", NZ: "New Zealand", BR: "Brazil", MX: "Mexico",
};

const LANGUAGE_CHOICES: readonly SettingChoice[] = Object.entries(LANGUAGE_NAMES).map(([value, label]) => ({ value, label }));

/**
 * Countries, named, each showing the currency choosing it produces.
 *
 * Sorted by name rather than by code, because someone looking for Rwanda is looking for "Rwanda".
 */
const COUNTRY_CHOICES: readonly SettingChoice[] = SUPPORTED_COUNTRIES
  .map((code) => ({ value: code, label: `${COUNTRY_NAMES[code] ?? code} (${code}) — ${currencyForCountry(code)}` }))
  .sort((left, right) => left.label.localeCompare(right.label));

const CURRENCY_CHOICES: readonly SettingChoice[] = [...new Set(SUPPORTED_COUNTRIES.map((code) => currencyForCountry(code)!))]
  .sort()
  .map((value) => ({ value, label: value }));

const ON_OFF_CHOICES: readonly SettingChoice[] = [
  { value: "off", label: "Off — rule-based suggestions only" },
  { value: "on", label: "On — the model may add up to two more" },
];

const PROVIDER_CHOICES: readonly SettingChoice[] = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "circuitnotion", label: "CircuitNotion" },
  { value: "ollama", label: "Ollama (local)" },
];

/**
 * Settings Nova may persist. Unknown JSON keys are ignored on read.
 *
 * A `choices` list means the value is picked, not typed. Every one of these was previously a
 * free-text box whose valid answers lived only in the label and the validator — you had to know
 * that Rwanda is `RW` before the field could help you, which is backwards: the list of countries
 * Nova can price in is a fact it already holds.
 */
export const SETTING_FIELDS = [
  { key: "NOVA_LANGUAGE", label: "Control language", choices: LANGUAGE_CHOICES },
  { key: "NOVA_COUNTRY", label: "Location — sets the currency costs are shown in", choices: COUNTRY_CHOICES },
  { key: "NOVA_CURRENCY", label: "Display currency (overrides the one your location implies)", choices: CURRENCY_CHOICES },
  { key: "NOVA_PROVIDER", label: "Default provider", choices: PROVIDER_CHOICES },
  { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", secret: true },
  { key: "ANTHROPIC_BASE_URL", label: "Anthropic base URL", url: true },
  { key: "ANTHROPIC_MODEL", label: "Anthropic model" },
  { key: "OPENAI_API_KEY", label: "OpenAI API key", secret: true },
  { key: "OPENAI_BASE_URL", label: "OpenAI-compatible base URL", url: true },
  { key: "OPENAI_MODEL", label: "OpenAI model" },
  { key: "CIRCUITNOTION_API_KEY", label: "CircuitNotion API key", secret: true },
  { key: "CIRCUITNOTION_BASE_URL", label: "CircuitNotion base URL", url: true },
  { key: "CIRCUITNOTION_RELAY_SECRET", label: "CircuitNotion relay secret", secret: true },
  { key: "CIRCUITNOTION_MODEL", label: "CircuitNotion model" },
  { key: "OLLAMA_BASE_URL", label: "Ollama base URL (default http://localhost:11434/v1)", url: true },
  { key: "OLLAMA_MODEL", label: "Ollama model" },
  { key: "E2B_API_KEY", label: "E2B API key", secret: true },
  { key: "E2B_CODING_TEMPLATE", label: "E2B template" },
  { key: "EXA_API_KEY", label: "Exa search API key", secret: true },
  { key: "EXA_BASE_URL", label: "Exa base URL", url: true },
  { key: "VOICE_TRANSCRIPTION_URL", label: "Speech-to-text URL", url: true },
  { key: "VOICE_MODEL", label: "Speech-to-text model" },
  { key: "VOICE_INPUT_DEVICE", label: "Microphone device override" },
  { key: "MODEL_INPUT_PER_MILLION", label: "Input price per million tokens" },
  { key: "MODEL_OUTPUT_PER_MILLION", label: "Output price per million tokens" },
  { key: "MODEL_CACHED_INPUT_PER_MILLION", label: "Cached input price per million tokens" },
  { key: "MODEL_PRICE_CURRENCY", label: "Model price currency" },
  { key: "MODEL_PRICE_MODEL", label: "Model the price override applies to" },
  { key: "NOVA_KEYS", label: "Key bindings, e.g. /diff=alt+d,/wander=off" },
  // Off by default, and the label says what it costs: the deterministic suggestions are free and
  // instant, and this buys two extra project-specific ones for a small model call per turn. A
  // feature that quietly bills a person for a hint is a feature they turn off once and distrust
  // afterwards.
  { key: "NOVA_SUGGEST_MODEL", label: "Ask the model for extra suggestions (a small extra call per turn)", choices: ON_OFF_CHOICES },
] as const;

export type SettingKey = typeof SETTING_FIELDS[number]["key"];
export type NovaSettings = Partial<Record<SettingKey, string>>;

/** Native per-user config location on Windows, macOS and freedesktop systems. */
export function settingsDirectory(environment: Record<string, string | undefined> = process.env, platform = process.platform): string {
  if (environment.NOVA_CONFIG_DIR?.trim()) return path.resolve(environment.NOVA_CONFIG_DIR);
  if (platform === "win32") return path.join(environment.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming"), "Nova");
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Nova");
  return path.join(environment.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"), "nova");
}

export function settingsFile(environment: Record<string, string | undefined> = process.env, platform = process.platform): string {
  return path.join(settingsDirectory(environment, platform), "settings.json");
}

function cleanSettings(value: unknown): NovaSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const settings: NovaSettings = {};
  for (const field of SETTING_FIELDS) {
    const item = source[field.key];
    if (typeof item === "string" && item.trim()) settings[field.key] = item.trim();
  }
  return settings;
}

export async function loadSettings(environment: Record<string, string | undefined> = process.env, platform = process.platform): Promise<NovaSettings> {
  try {
    return cleanSettings(JSON.parse(await fs.readFile(settingsFile(environment, platform), "utf8")));
  } catch {
    return {};
  }
}

export async function saveSettings(settings: NovaSettings, environment: Record<string, string | undefined> = process.env, platform = process.platform): Promise<string> {
  const directory = settingsDirectory(environment, platform);
  const file = settingsFile(environment, platform);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(cleanSettings(settings), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(temporary, 0o600).catch(() => undefined);
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
  return file;
}

export function mergedEnvironment(settings: NovaSettings, environment: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  // Real environment variables win, which keeps CI, containers and one-off shell overrides
  // predictable even after a user has configured the interactive CLI.
  return { ...settings, ...environment };
}

export function maskSetting(value: string | undefined): string {
  if (!value) return "not set";
  if (value.length <= 8) return "set (hidden)";
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

export function validateSetting(key: SettingKey, raw: string): string {
  const value = raw.trim();
  const field = SETTING_FIELDS.find((candidate) => candidate.key === key)!;
  if (!value) throw new Error("Value cannot be empty. Enter - in the menu to clear it.");
  if ("url" in field && field.url) {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("Enter a complete URL, for example https://api.example.com/v1."); }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("URLs must use HTTPS (HTTP is allowed only for localhost).");
    return url.href.replace(/\/$/, "");
  }
  if (/PER_MILLION$/.test(key)) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Price must be a non-negative number.");
  }
  if (key === "MODEL_PRICE_CURRENCY" && !/^[A-Za-z]{3}$/.test(value)) throw new Error("Currency must be a three-letter ISO code such as USD.");
  if (key === "NOVA_LANGUAGE" && !/^(en|zh|hi|es|fr|ar|bn|pt|ru|ur)$/i.test(value)) throw new Error("Choose en, zh, hi, es, fr, ar, bn, pt, ru, or ur.");
  if (key === "NOVA_PROVIDER" && !/^(anthropic|openai|circuitnotion)$/i.test(value)) throw new Error("Choose anthropic, openai, or circuitnotion.");
  if (key === "NOVA_PROVIDER") return value.toLowerCase();
  if (key === "NOVA_COUNTRY") {
    const country = normalizeCountryCode(value);
    if (!country) throw new Error("Enter a two-letter ISO country code, such as RW or EG.");
    // Refused rather than accepted-and-ignored: the point of setting a location is the currency,
    // and a code with no currency behind it would save cleanly and then change nothing.
    if (!currencyForCountry(country)) {
      throw new Error(`No local currency is known for ${country}. Set the display currency directly instead, or choose one of: ${SUPPORTED_COUNTRIES.join(", ")}.`);
    }
    return country;
  }
  if (key === "NOVA_CURRENCY") {
    const currency = value.toUpperCase();
    if (!isCurrency(currency)) throw new Error(`${currency} is not a currency Nova can convert to. Leave this empty to use the one your location implies.`);
    return currency;
  }
  return key === "MODEL_PRICE_CURRENCY" ? value.toUpperCase() : value;
}

export type SettingsPrompts = {
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  write(text: string): void;
  /**
   * Renders an arrow-navigable list and resolves to the chosen value, or undefined if dismissed.
   *
   * Optional, and the menu is written to work without it. Borrowing the keyboard needs a real TTY
   * and a readline to borrow from, which a piped run, a first-run script and every test in this
   * file do not have — so the typed numbered menu remains the base case rather than a degraded one.
   */
  choose?<T>(request: {
    title: string;
    items: readonly { value: T; label: string; description?: string; hint?: string; pinned?: boolean }[];
    filter?: boolean;
    initialIndex?: number;
  }): Promise<T | undefined>;
};

/** Numbered, screen-reader-friendly settings menu. Secrets are never printed back to the terminal. */
/**
 * The keys that decide whether Nova can run at all. One of these is the entire requirement.
 *
 * Kept as its own list so the first-run menu can ask for exactly that and nothing else: someone who
 * has just installed Nova and wants to use Claude should not have to find "Anthropic API key" at
 * position 2 of 24, between a control-language selector and a CircuitNotion relay secret. Every
 * other setting has a sensible default and can be changed later from `/settings`.
 */
const PROVIDER_KEY_FIELDS = SETTING_FIELDS.filter((field) =>
  field.key === "ANTHROPIC_API_KEY" || field.key === "OPENAI_API_KEY" || field.key === "CIRCUITNOTION_API_KEY");

export type SettingsMenuOptions = {
  /**
   * Show only the provider keys, with a way to reveal the rest.
   *
   * Used on a first run, where the question is "which provider are you using?" and a wall of
   * twenty-four unrelated options is an obstacle between someone and their first working session.
   */
  focus?: "providers";
};

/** What the menu is asking for, when a caller can render a real chooser. */
export type SettingsSelection =
  | { kind: "field"; key: SettingKey }
  | { kind: "expand" }
  | { kind: "done" };

export async function runSettingsMenu(current: NovaSettings, prompts: SettingsPrompts, options: SettingsMenuOptions = {}): Promise<NovaSettings> {
  const settings = { ...current };
  let focused = options.focus === "providers";
  /** Where the field list reopens after editing something. */
  let cursor = 0;
  for (;;) {
    const language = resolveControlLanguage(settings.NOVA_LANGUAGE);
    const fields = focused ? PROVIDER_KEY_FIELDS : SETTING_FIELDS;
    const describe = (field: typeof SETTING_FIELDS[number]) => {
      const value = settings[field.key];
      return "secret" in field && field.secret ? maskSetting(value) : value || "not set";
    };

    let selection: SettingsSelection;
    if (prompts.choose) {
      // Arrow-driven when the caller can borrow the keyboard. The rows carry their current values
      // so the menu answers "what is set?" without anyone having to open each field to find out.
      const items = [
        ...fields.map((field) => ({ value: { kind: "field", key: field.key } as SettingsSelection, label: field.label, hint: describe(field) })),
        ...(focused ? [{ value: { kind: "expand" } as SettingsSelection, label: "Everything else", description: "base URLs, models, pricing, voice, keys", pinned: true }] : []),
        { value: { kind: "done" } as SettingsSelection, label: `${controlLabel(language, "saved")} / ${controlLabel(language, "exit")}`, pinned: true },
      ];
      const chosen = await prompts.choose({
        title: `Nova ${controlLabel(language, "settings")}`,
        items,
        // Reopens where the user was, not at the top. Setting three things in a row otherwise means
        // scrolling back down twice, and the list is long enough for that to be the whole cost of
        // using it.
        initialIndex: cursor,
      });
      // Escape means "leave the menu", the same as choosing the exit row.
      selection = chosen ?? { kind: "done" };
      const chosenIndex = items.findIndex((item) => item.value === chosen);
      if (chosenIndex >= 0) cursor = chosenIndex;
    } else {
      // The typed path stays, and stays first-class. It is what a pipe, a test and a terminal too
      // small to paint into all use, and it is the accessible reading of the same menu.
      prompts.write(`\nNova ${controlLabel(language, "settings")}\n`);
      fields.forEach((field, index) => prompts.write(`  ${String(index + 1).padStart(2)}. ${field.label}: ${describe(field)}\n`));
      if (focused) prompts.write("   a. everything else (base URLs, models, pricing, voice, keys)\n");
      prompts.write(`   q. ${controlLabel(language, "saved")} / ${controlLabel(language, "exit")}\n`);
      const choice = (await prompts.ask(`${controlLabel(language, "choose")}: `)).trim().toLowerCase();
      if (choice === "q" || choice === "done" || choice === "exit") selection = { kind: "done" };
      else if (focused && choice === "a") selection = { kind: "expand" };
      else {
        const field = fields[Number(choice) - 1];
        if (!field) {
          prompts.write(`Choose a number from the menu${focused ? ", a for the full list" : ""}, or q to save.\n`);
          continue;
        }
        selection = { kind: "field", key: field.key };
      }
    }

    if (selection.kind === "done") return settings;
    // The full list is a different list; a position in the short one means nothing in it.
    if (selection.kind === "expand") { focused = false; cursor = 0; continue; }
    const field = SETTING_FIELDS.find((candidate) => candidate.key === selection.key)!;

    // A field with a fixed set of answers is picked, not typed — but only when there is a chooser
    // to pick with. Without one it falls back to the same free-text prompt it always had.
    if ("choices" in field && field.choices && prompts.choose) {
      const picked = await prompts.choose({
        title: field.label,
        filter: true,
        items: [
          ...field.choices.map((choice) => ({
            value: choice.value,
            label: choice.label,
            ...(settings[field.key] === choice.value ? { hint: "current" } : {}),
          })),
          { value: "-", label: "Clear this setting", pinned: true },
        ],
        initialIndex: Math.max(0, field.choices.findIndex((choice) => choice.value === settings[field.key])),
      });
      if (picked === undefined) continue;
      if (picked === "-") {
        delete settings[field.key];
        prompts.write(`${field.label} cleared.\n`);
        continue;
      }
      settings[field.key] = validateSetting(field.key, picked);
      prompts.write(`${field.label} saved in this menu.\n`);
      continue;
    }

    const raw = await ("secret" in field && field.secret ? prompts.askSecret(`${field.label} (paste hidden; - clears): `) : prompts.ask(`${field.label} (- clears): `));
    if (raw.trim() === "-") {
      delete settings[field.key];
      prompts.write(`${field.label} cleared.\n`);
      continue;
    }
    try {
      settings[field.key] = validateSetting(field.key, raw);
      prompts.write(`${field.label} saved in this menu.\n`);
    } catch (error) {
      prompts.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
