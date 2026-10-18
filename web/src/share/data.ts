import type { SharePublicData } from "@cellar/shared";

/**
 * Validation of the server-injected share payload, by hand: zod would multiply
 * this bundle's size. Type-only imports from @cellar/shared are erased at
 * build time, so the share entry shares no module with the admin SPA (a
 * shared chunk would not be named share-* and /s/assets would 404 it).
 *
 * The page never follows a URL from the payload. Every request goes to a path
 * it builds itself under /s/<token>/, so the payload decides only what is
 * shown, never where the browser goes.
 */

export type ShareData = SharePublicData;
export type ShareVideo = SharePublicData["video"];
export type ShareMedia = NonNullable<SharePublicData["media"]>;
export type ShareCaption = SharePublicData["captions"][number];

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function readVideo(value: unknown): ShareVideo | null {
  if (!isRecord(value) || typeof value["id"] !== "string") return null;
  const video: ShareVideo = {
    id: value["id"],
    title: value["title"] as string | null,
    channel_title: value["channel_title"] as string | null,
    upload_date: value["upload_date"] as number | null,
    duration_s: value["duration_s"] as number | null,
    description: value["description"] as string | null,
    views: value["views"] as number | null,
    likes: value["likes"] as number | null,
  };
  const ok =
    isNullableString(video.title) &&
    isNullableString(video.channel_title) &&
    isNullableString(video.description) &&
    isNullableNumber(video.upload_date) &&
    isNullableNumber(video.duration_s) &&
    isNullableNumber(video.views) &&
    isNullableNumber(video.likes);
  return ok ? video : null;
}

function readMedia(value: unknown): ShareMedia | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const kind = value["kind"];
  const media = {
    kind,
    mime: value["mime"],
    size_bytes: value["size_bytes"],
    height: value["height"],
    has_audio_only: value["has_audio_only"],
  };
  const ok =
    (kind === "video" || kind === "audio") &&
    typeof media.mime === "string" &&
    typeof media.size_bytes === "number" &&
    isNullableNumber(media.height) &&
    typeof media.has_audio_only === "boolean";
  return ok ? (media as ShareMedia) : undefined;
}

const LANG_RE = /^[A-Za-z0-9_-]{1,32}$/;

function readCaptions(value: unknown): ShareCaption[] | null {
  if (!Array.isArray(value)) return null;
  const out: ShareCaption[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { lang, label } = item;
    if (typeof lang !== "string" || !LANG_RE.test(lang) || typeof label !== "string") return null;
    out.push({ lang, label });
  }
  return out;
}

function readDownloads(value: unknown): ShareData["downloads"] | null {
  if (!isRecord(value) || !isRecord(value["captions"])) return null;
  const captions: Record<string, string> = {};
  for (const [lang, url] of Object.entries(value["captions"])) {
    if (typeof url !== "string") return null;
    captions[lang] = url;
  }
  const video = value["video"];
  const audio = value["audio"];
  if (video !== undefined && typeof video !== "string") return null;
  if (audio !== undefined && typeof audio !== "string") return null;
  if (typeof value["metadata"] !== "string") return null;
  return {
    ...(video === undefined ? {} : { video }),
    ...(audio === undefined ? {} : { audio }),
    captions,
    metadata: value["metadata"],
  };
}

/**
 * The payload when it is well formed and names the token in the URL; null
 * otherwise, which renders the same 404 view as an absent payload.
 */
export function parseShareData(value: unknown, token: string): ShareData | null {
  if (!isRecord(value) || value["token"] !== token || !TOKEN_RE.test(token)) return null;
  const video = readVideo(value["video"]);
  const media = readMedia(value["media"]);
  const captions = readCaptions(value["captions"]);
  const downloads = readDownloads(value["downloads"]);
  if (video === null || media === undefined || captions === null || downloads === null) {
    return null;
  }
  if (typeof value["thumbnail"] !== "boolean") return null;
  return { token, video, media, captions, thumbnail: value["thumbnail"], downloads };
}

/** Same-origin paths of one share. Built here, never read from the payload. */
export function shareUrls(token: string) {
  const base = `/s/${token}`;
  return {
    video: `${base}/video`,
    audio: `${base}/audio`,
    thumbnail: `${base}/thumbnail`,
    metadata: `${base}/metadata.json`,
    captions: (lang: string) => `${base}/captions/${encodeURIComponent(lang)}`,
    download: (path: string) => `${path}?download=1`,
  };
}
