/** Matches Exa's documented domain or domain/path constraints without trusting string prefixes. */
export function allowedResearchUrl(rawUrl: string, constraints: readonly string[]): boolean {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  return constraints.some((constraint) => {
    const [rawHost, ...pathParts] = constraint.toLowerCase().replace(/^www\./, "").split("/");
    const hostMatches = hostname === rawHost || hostname.endsWith(`.${rawHost}`);
    if (!hostMatches) return false;
    const requiredPath = pathParts.length > 0 ? `/${pathParts.join("/")}` : "";
    return !requiredPath || url.pathname.toLowerCase() === requiredPath || url.pathname.toLowerCase().startsWith(`${requiredPath}/`);
  });
}
