import { NextResponse, type NextRequest } from "next/server";

const REALM = "circuit-nova";
const PUBLIC_INFRASTRUCTURE_PATHS = new Set([
  "/api/defender-brain/manifest",
  "/api/defender-brain/corpus",
]);

/** Machine-consumed, cryptographically verified distribution cannot depend on the web UI gate. */
export function isPublicInfrastructurePath(pathname: string): boolean {
  return PUBLIC_INFRASTRUCTURE_PATHS.has(pathname);
}

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"` },
  });
}

/**
 * A free, whole-site shared-password gate for the deployed preview: Vercel's own Password
 * Protection requires a paid Advanced Deployment Protection add-on this team doesn't have.
 * Opt-in via SITE_ACCESS_PASSWORD — unset (the local/dev default), this is a no-op so nothing
 * changes for development.
 */
export function middleware(request: NextRequest): NextResponse {
  // The corpus is public data and the manifest is authenticated by Nova's pinned Ed25519 key.
  // Keep this exact-path allowlist narrow: no other control-plane API inherits the exemption.
  if (isPublicInfrastructurePath(request.nextUrl.pathname)) return NextResponse.next();
  const password = process.env.SITE_ACCESS_PASSWORD;
  if (!password) return NextResponse.next();

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return unauthorized();

  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length));
  } catch {
    return unauthorized();
  }
  const separatorIndex = decoded.indexOf(":");
  const suppliedPassword = separatorIndex === -1 ? decoded : decoded.slice(separatorIndex + 1);
  if (suppliedPassword !== password) return unauthorized();

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
