/**
 * The only paths that skip Cloudflare Access. Everything else is guarded.
 *
 * "/s" rather than "/s/": the Cloudflare Access bypass application is scoped to
 * the destination path "/s", which covers the bare path too.
 */
export const DEFAULT_PUBLIC_PREFIXES = ["/healthz", "/s"] as const;

/**
 * The pathname a request is routed on, with the query string and any fragment
 * removed. Public-prefix matching uses this rather than the raw url so a query
 * string can never smuggle a public path into an authenticated route.
 */
export function requestPathname(url: string): string {
  const queryIndex = url.search(/[?#]/);
  const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
  return path === "" ? "/" : path;
}

/**
 * A prefix covers the exact path and everything below it, which is how
 * Cloudflare Access scopes an application by destination path: a bypass policy
 * on "/s" applies to "/s" itself as well as "/s/*". This middleware has to
 * agree with that scoping exactly. When it exempts less than the edge
 * bypasses, bare "/s" answers 401 and demands authentication that can never
 * arrive, because Cloudflare has already waved the request through.
 *
 * The boundary is a path separator, never a character count, so "/s" does not
 * cover "/sx" or "/settings". Matching is case sensitive, so "/S/x" stays
 * authenticated.
 */
export function isPublicPath(pathname: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (pathname === prefix) {
      return true;
    }
    const withSlash = prefix.endsWith("/") ? prefix : `${prefix}/`;
    if (pathname === withSlash || pathname.startsWith(withSlash)) {
      return true;
    }
  }
  return false;
}
