/**
 * YouTube identifier parsing. Pure logic, no IO: used by the server (Inspect
 * page, manual channel add, Takeout import) and by the web UI (live preview).
 *
 * The parser is deliberately hand-rolled rather than built on the `URL` global
 * so it behaves identically in every runtime that consumes `@cellar/shared`.
 */

/** A YouTube video id: exactly 11 characters of `[A-Za-z0-9_-]`. */
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** A YouTube channel id: `UC` followed by 22 characters of `[A-Za-z0-9_-]`. */
export const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

/** Handles are 3 to 30 characters of letters, digits, `.`, `_` and `-`. */
const HANDLE_RE = /^[\p{L}\p{N}._-]{3,30}$/u;

/** Legacy `/c/<name>` and `/user/<name>` segments. */
const LEGACY_NAME_RE = /^[\p{L}\p{N}._-]{1,100}$/u;

/** Hosts serving the regular YouTube site (watch pages, shorts, channels). */
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "gaming.youtube.com",
]);

/** Hosts that only ever serve embeds. */
const EMBED_HOSTS = new Set(["youtube-nocookie.com", "www.youtube-nocookie.com"]);

/** The short-link host. */
const SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);

/** Path prefixes whose next segment is a video id: `/shorts/ID`, `/embed/ID`, ... */
const ID_PATH_PREFIXES = new Set(["shorts", "live", "embed", "v", "e", "watch"]);

interface SplitUrl {
  host: string;
  /** Path segments with empty segments dropped. */
  segments: string[];
  query: Map<string, string>;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function parseQuery(query: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of query.split(/[&;]/)) {
    if (part === "") {
      continue;
    }
    const eq = part.indexOf("=");
    const key = safeDecode(eq === -1 ? part : part.slice(0, eq));
    const value = eq === -1 ? "" : safeDecode(part.slice(eq + 1));
    // First occurrence wins, matching how YouTube itself reads `v`.
    if (!out.has(key)) {
      out.set(key, value);
    }
  }
  return out;
}

/**
 * Split a URL-ish string into host, path segments and query. Accepts input
 * with or without an `http(s)://` scheme. Returns null when the input does not
 * look like a URL at all or carries a different scheme.
 */
function splitUrl(input: string): SplitUrl | null {
  let rest = input;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(rest);
  if (scheme) {
    const name = (scheme[1] ?? "").toLowerCase();
    if (name !== "http" && name !== "https") {
      return null;
    }
    rest = rest.slice(scheme[0].length);
  } else if (rest.startsWith("//")) {
    rest = rest.slice(2);
  }
  if (/\s/.test(rest)) {
    return null;
  }

  // Fragments can carry query-like data (`#t=30`), but never the id we want.
  const hashIndex = rest.indexOf("#");
  if (hashIndex >= 0) {
    rest = rest.slice(0, hashIndex);
  }
  let query = "";
  const queryIndex = rest.indexOf("?");
  if (queryIndex >= 0) {
    query = rest.slice(queryIndex + 1);
    rest = rest.slice(0, queryIndex);
  }

  const slashIndex = rest.indexOf("/");
  let authority = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
  const path = slashIndex === -1 ? "" : rest.slice(slashIndex + 1);

  // Drop userinfo and port; neither changes which video is meant.
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    authority = authority.slice(at + 1);
  }
  const host = authority.replace(/:\d*$/, "").replace(/\.$/, "").toLowerCase();
  if (host === "" || !host.includes(".")) {
    return null;
  }

  return {
    host,
    segments: path.split("/").filter((segment) => segment !== ""),
    query: parseQuery(query),
  };
}

function asVideoId(value: string | undefined): string | null {
  return value !== undefined && VIDEO_ID_RE.test(value) ? value : null;
}

function videoIdFromUrl(url: SplitUrl): string | null {
  const first = url.segments[0];
  const second = url.segments[1];

  if (SHORT_HOSTS.has(url.host)) {
    // youtu.be/ID, and the odd youtu.be/watch?v=ID shape seen in share sheets.
    if (first === "watch") {
      return url.segments.length === 1 ? asVideoId(url.query.get("v")) : null;
    }
    return url.segments.length === 1 ? asVideoId(first) : null;
  }

  if (!YOUTUBE_HOSTS.has(url.host) && !EMBED_HOSTS.has(url.host)) {
    return null;
  }

  if (first === undefined) {
    // youtube.com/?v=ID is accepted by YouTube and redirects to the watch page.
    return asVideoId(url.query.get("v"));
  }
  const lowerFirst = first.toLowerCase();
  if (lowerFirst === "watch" && url.segments.length === 1) {
    return asVideoId(url.query.get("v"));
  }
  if (ID_PATH_PREFIXES.has(lowerFirst) && url.segments.length === 2) {
    // `/embed/videoseries?list=...` is a playlist embed whose segment happens to
    // be 11 id-shaped characters.
    return second === "videoseries" ? null : asVideoId(second);
  }
  return null;
}

/**
 * Extract the 11-character video id from any of the identifier forms YouTube
 * uses: watch URLs (with any extra parameters, `v` not necessarily first, with
 * or without a playlist), youtu.be short links, `/shorts/`, `/live/`,
 * `/embed/`, `/v/`, the music and mobile hosts, scheme-less forms, and a bare
 * id. Returns null for playlist-only URLs, channel URLs and anything else.
 */
export function parseVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }
  if (VIDEO_ID_RE.test(trimmed)) {
    return trimmed;
  }
  const url = splitUrl(trimmed);
  return url === null ? null : videoIdFromUrl(url);
}

/** True when `id` is a syntactically valid video id. */
export function isVideoId(id: string): boolean {
  return VIDEO_ID_RE.test(id);
}

/** True when `id` is a syntactically valid `UC...` channel id. */
export function isChannelId(id: string): boolean {
  return CHANNEL_ID_RE.test(id);
}

/** The canonical watch URL for a video id. Throws on an invalid id. */
export function canonicalWatchUrl(id: string): string {
  if (!VIDEO_ID_RE.test(id)) {
    throw new RangeError(`Invalid YouTube video id: ${JSON.stringify(id)}`);
  }
  return `https://www.youtube.com/watch?v=${id}`;
}

export type ChannelRefKind = "id" | "handle" | "url-custom" | "user";

/**
 * A reference to a channel as a user typed it. `value` is the channel id for
 * `id`, the handle WITHOUT its leading `@` for `handle`, and the bare name for
 * `url-custom` (`/c/<name>`) and `user` (`/user/<name>`). Only `id` is
 * directly usable; the others need an API lookup (`forHandle`, `forUsername`)
 * or a page resolve on the server.
 */
export interface ChannelRef {
  kind: ChannelRefKind;
  value: string;
}

function handleRef(raw: string): ChannelRef | null {
  const handle = safeDecode(raw.startsWith("@") ? raw.slice(1) : raw);
  return HANDLE_RE.test(handle) ? { kind: "handle", value: handle } : null;
}

/**
 * Parse a channel reference: a bare `UC...` id, a bare `@handle`, or a channel
 * URL (`youtube.com/@handle`, `/channel/UC...`, `/c/name`, `/user/name`),
 * optionally followed by a tab such as `/videos` and query parameters.
 * Returns null for video URLs, playlists and anything else.
 */
export function parseChannelRef(input: string): ChannelRef | null {
  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }
  if (CHANNEL_ID_RE.test(trimmed)) {
    return { kind: "id", value: trimmed };
  }
  if (trimmed.startsWith("@")) {
    return handleRef(trimmed);
  }

  const url = splitUrl(trimmed);
  if (url === null || !YOUTUBE_HOSTS.has(url.host)) {
    return null;
  }
  const [first, second] = url.segments;
  if (first === undefined) {
    return null;
  }
  // A channel page may carry a tab (`/videos`, `/featured`, `/shorts`), but never
  // more than one extra segment.
  if (first.startsWith("@") || first.toLowerCase().startsWith("%40")) {
    if (url.segments.length > 2) {
      return null;
    }
    return handleRef(safeDecode(first));
  }
  if (second === undefined || url.segments.length > 3) {
    return null;
  }
  const name = safeDecode(second);
  switch (first.toLowerCase()) {
    case "channel":
      return CHANNEL_ID_RE.test(name) ? { kind: "id", value: name } : null;
    case "c":
      return LEGACY_NAME_RE.test(name) ? { kind: "url-custom", value: name } : null;
    case "user":
      return LEGACY_NAME_RE.test(name) ? { kind: "user", value: name } : null;
    default:
      return null;
  }
}
