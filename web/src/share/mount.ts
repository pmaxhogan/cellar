/**
 * The public share page (/s/<token>).
 *
 * The server answers every /s/<token> request with the same share.html. For a
 * live link it injects the share payload as
 *
 *   <script id="share-data" type="application/json">{...}</script>
 *
 * and for an unknown, expired or revoked token it injects nothing. The page
 * therefore never asks the server whether a token is valid: absent data is the
 * 404 view, and that view is identical for all three causes so a visitor cannot
 * tell them apart.
 *
 * Everything is built with createElement + textContent. Nothing from the URL or
 * the payload is ever parsed as HTML.
 */

export const SHARE_DATA_ID = "share-data";
export const NOT_FOUND_TITLE = "Not found";
export const NOT_FOUND_MESSAGE = "This link does not exist, has expired, or was revoked.";

export type ShareView = "player" | "not-found";

/**
 * The injected payload. Wave 5 narrows this to the player contract; it is
 * validated by hand there because zod alone would multiply this bundle's size.
 */
export type ShareData = Record<string, unknown>;

const TOKEN_PATH = /^\/s\/([A-Za-z0-9_-]+)\/?$/;

/** The token from `/s/<token>`, or null for any other path. */
export function shareTokenFromPath(pathname: string): string | null {
  return TOKEN_PATH.exec(pathname)?.[1] ?? null;
}

/** The server-injected payload, or null when it is absent or unreadable. */
export function readShareData(doc: Document): ShareData | null {
  const node = doc.getElementById(SHARE_DATA_ID);
  if (node === null || node.getAttribute("type") !== "application/json") return null;
  try {
    const value: unknown = JSON.parse(node.textContent ?? "");
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return value as ShareData;
  } catch {
    return null;
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The uniform 404 view: a title and one sentence, nothing else. */
export function renderNotFound(root: HTMLElement, doc: Document): void {
  doc.title = NOT_FOUND_TITLE;
  const main = element(doc, "main", "share-notfound");
  main.append(
    element(doc, "h1", "share-notfound__title", NOT_FOUND_TITLE),
    element(doc, "p", "share-notfound__message", NOT_FOUND_MESSAGE),
  );
  root.replaceChildren(main);
}

/**
 * Placeholder for the wave 5 player (video with captions and speed control,
 * metadata, download buttons). It renders only the title so the data path is
 * wired and tested end to end before the player exists.
 */
export function renderPlayer(root: HTMLElement, doc: Document, data: ShareData): void {
  const title = typeof data["title"] === "string" && data["title"] !== "" ? data["title"] : null;
  doc.title = title ?? "Shared video";
  const main = element(doc, "main", "share-player");
  main.append(element(doc, "h1", "share-player__title", title ?? "Shared video"));
  root.replaceChildren(main);
}

/** Pick and render the view for this page load. */
export function mountShare(doc: Document, pathname: string): ShareView {
  const root = doc.getElementById("app") ?? doc.body;
  const token = shareTokenFromPath(pathname);
  const data = token === null ? null : readShareData(doc);
  if (data === null) {
    renderNotFound(root, doc);
    return "not-found";
  }
  renderPlayer(root, doc, data);
  return "player";
}
