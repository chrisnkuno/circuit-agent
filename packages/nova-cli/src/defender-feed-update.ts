/** Non-blocking CLI scheduler for the central Defensive Brain feed. */
import { refreshDefenderFeed, type DefenderFeedResult } from "@circuit-nova/nova-core/nova-cli/defender-feed";

export const OFFICIAL_DEFENDER_FEED_URL = "https://circuit-nova.vercel.app/api/defender-brain/manifest";

/**
 * Release keys are intentionally a map: adding a successor before retiring its predecessor makes
 * key rotation possible without an update outage. Environment-supplied keys remain available for
 * controlled staging feeds, but the official authority is rooted here rather than in the network.
 */
export const OFFICIAL_DEFENDER_FEED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "release-2026-01": "MCowBQYDK2VwAyEA4/jb1zd6f+jIPAFja1bPNtroXV8MtAZFrKt5BSY+ngI=",
});

export function defenderFeedKeys(environment: Record<string, string | undefined>): Readonly<Record<string, string>> {
  const configured = environment.NOVA_DEFENDER_BRAIN_PUBLIC_KEYS?.trim();
  if (!configured) return OFFICIAL_DEFENDER_FEED_KEYS;
  try {
    const parsed = JSON.parse(configured) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([id, key]) => /^[a-zA-Z0-9._-]{1,64}$/.test(id) && typeof key === "string" && key.length <= 4_096));
  } catch { return {}; }
}

export async function updateDefenderFeed(environment: Record<string, string | undefined>): Promise<DefenderFeedResult> {
  const keys = defenderFeedKeys(environment);
  if (Object.keys(keys).length === 0) return { status: "not_configured" };
  return refreshDefenderFeed({
    environment: { ...environment, NOVA_DEFENDER_FEED_URL: environment.NOVA_DEFENDER_FEED_URL?.trim() || OFFICIAL_DEFENDER_FEED_URL },
    keys,
  });
}
