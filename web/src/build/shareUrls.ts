/**
 * Build-time URL policy for the two Vite entries, kept out of vite.config.ts so
 * it can be unit tested without loading the config.
 *
 * The admin SPA (index.html) is served at / and the public share page
 * (share.html) for /s/<token>. The server mounts dist/assets twice: at
 * /assets/ behind Access and at /s/assets/ inside the public bypass. So every
 * URL written into share.html, or into a file the share entry emits, must start
 * with /s/, while the admin entry keeps the default /assets/.
 *
 * Share files are named `share-*`. Keying the prefix on the host that contains
 * the URL, rather than on the asset itself, means a chunk the two entries ever
 * share still resolves from either side.
 */

export const SHARE_ENTRY = "share";
export const SHARE_PUBLIC_PREFIX = "/s/";

/** True for share.html and for every file the share entry emits. */
export function isShareHost(hostId: string): boolean {
  const name = hostId.replace(/\\/g, "/").split("/").pop() ?? "";
  return name === `${SHARE_ENTRY}.html` || name.startsWith(`${SHARE_ENTRY}-`);
}

/** experimental.renderBuiltUrl: undefined keeps Vite's default (base + filename). */
export function shareAwareUrl(filename: string, context: { hostId: string }): string | undefined {
  if (!isShareHost(context.hostId)) return undefined;
  return `${SHARE_PUBLIC_PREFIX}${filename}`;
}
