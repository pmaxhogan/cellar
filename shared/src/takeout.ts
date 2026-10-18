/**
 * Parsers for the YouTube part of a Google Takeout export (spec 3.1, 4.6, 12).
 * Pure logic over file text, no IO: the server unzips and hands each file's
 * text here, then upserts the rows. Rows are NOT deduplicated (a video watched
 * three times yields three history rows); idempotency belongs to the importer.
 */

import { CHANNEL_ID_RE, parseChannelRef, parseVideoId } from "./idParser.ts";

/** Which parser applies to a Takeout file, named after the source it feeds. */
export type TakeoutFileKind =
  "history" | "watch_later" | "liked" | "subscription" | `playlist:${string}`;

/** Why an input entry or row produced no output row. */
export type TakeoutSkipReason =
  /** A history entry that is not a JSON object. */
  | "malformed-entry"
  /** A history entry served from Google Ads (`details: [{name: "From Google Ads"}]`). */
  | "ad"
  /** A history entry without `titleUrl`: a removed or private video. */
  | "no-url"
  /** A history entry whose `titleUrl` is not a video (a post, a channel, a visit). */
  | "not-a-video"
  /** A playlist CSV row whose `Video ID` cell is not a video id. */
  | "invalid-video-id"
  /** A subscriptions CSV row with neither a valid `Channel Id` nor a `/channel/UC...` URL. */
  | "invalid-channel-id";

export interface TakeoutVideoRow {
  videoId: string;
  /** Watch or playlist-add time in epoch ms; null when absent or unparseable. */
  ts: number | null;
}

export interface TakeoutChannelRow {
  channelId: string;
  title: string;
}

export interface TakeoutParseResult<Row> {
  rows: Row[];
  /** Count per skip reason; only reasons that occurred are present. */
  skipped: Partial<Record<TakeoutSkipReason, number>>;
}

/** The file is not the Takeout file it claims to be (bad JSON, no header row). */
export class TakeoutParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TakeoutParseError";
  }
}

const BOM = "\uFEFF";

function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

function bump<Row>(result: TakeoutParseResult<Row>, reason: TakeoutSkipReason): void {
  result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
}

// `2023-01-01T12:00:00.000Z`, `2023-01-01T12:00:00+00:00`, `2020-01-01 12:00:00 UTC`.
const TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i;

/**
 * Parse a Takeout timestamp to epoch ms. Accepts ISO 8601 (with `Z` or an
 * offset) and the older `YYYY-MM-DD HH:MM:SS UTC` form; a missing zone means
 * UTC. Returns null for anything else rather than trusting `Date.parse`, which
 * accepts junk such as `"1"`.
 */
export function parseTakeoutTimestamp(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = TIMESTAMP_RE.exec(value.trim());
  if (match === null) {
    return null;
  }
  const [, date, time, zone] = match;
  let offset = "Z";
  if (zone !== undefined && /^[+-]/.test(zone)) {
    offset = zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  }
  // Date.parse handles at most millisecond precision.
  const msTime = (time ?? "").replace(/(\.\d{3})\d+$/, "$1");
  const ms = Date.parse(`${date}T${msTime}${offset}`);
  return Number.isNaN(ms) ? null : ms;
}

function isAdEntry(entry: Record<string, unknown>): boolean {
  const details = entry.details;
  if (!Array.isArray(details)) {
    return false;
  }
  return details.some(
    (detail) =>
      typeof detail === "object" &&
      detail !== null &&
      (detail as Record<string, unknown>).name === "From Google Ads",
  );
}

/**
 * Parse `watch-history.json`: an array of `{title, titleUrl, time, ...}`
 * entries, newest first. Entries are checked in this order: not an object
 * (`malformed-entry`), an ad (`ad`, checked before the URL because ads carry a
 * real watch URL), no `titleUrl` (`no-url`), a URL that is not a video
 * (`not-a-video`). YouTube Music watches (`music.youtube.com`) are kept.
 *
 * Throws TakeoutParseError when the text is not JSON or not an array.
 */
export function parseWatchHistoryJson(text: string): TakeoutParseResult<TakeoutVideoRow> {
  let data: unknown;
  try {
    data = JSON.parse(stripBom(text));
  } catch {
    throw new TakeoutParseError("Watch history is not valid JSON");
  }
  if (!Array.isArray(data)) {
    throw new TakeoutParseError("Watch history JSON is not an array of entries");
  }

  const result: TakeoutParseResult<TakeoutVideoRow> = { rows: [], skipped: {} };
  for (const item of data) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      bump(result, "malformed-entry");
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (isAdEntry(entry)) {
      bump(result, "ad");
      continue;
    }
    const url = typeof entry.titleUrl === "string" ? entry.titleUrl.trim() : "";
    if (url === "") {
      bump(result, "no-url");
      continue;
    }
    // titleUrl must be a URL; parseVideoId alone would also accept a bare id.
    const videoId = url.includes("/") ? parseVideoId(url) : null;
    if (videoId === null) {
      bump(result, "not-a-video");
      continue;
    }
    result.rows.push({ videoId, ts: parseTakeoutTimestamp(entry.time) });
  }
  return result;
}

/**
 * Minimal RFC 4180 reader: quoted fields, `""` escapes, embedded newlines,
 * CRLF / LF / CR line ends. Never throws; an unterminated quote runs to EOF.
 */
function readCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  const input = stripBom(text);

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") {
        i++;
      }
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

function isBlank(record: readonly string[]): boolean {
  return record.every((cell) => cell.trim() === "");
}

/** Locate the first record containing `column` (case-insensitive, trimmed). */
function findHeader(
  records: readonly string[][],
  column: string,
): { index: number; header: string[] } | null {
  for (let i = 0; i < records.length; i++) {
    const header = (records[i] ?? []).map((cell) => cell.trim().toLowerCase());
    if (header.includes(column)) {
      return { index: i, header };
    }
  }
  return null;
}

const PLAYLIST_TIME_COLUMNS = ["playlist video creation timestamp", "time added"];

/**
 * Parse a Takeout playlist CSV. Handles both generations: the current
 * `Video ID,Playlist Video Creation Timestamp` file and the older form with a
 * playlist-metadata preamble, a blank line, then `Video ID,Time Added`. The
 * header row is found by content, not position.
 *
 * Throws TakeoutParseError when no `Video ID` header row exists.
 */
export function parsePlaylistCsv(text: string): TakeoutParseResult<TakeoutVideoRow> {
  const records = readCsv(text);
  const found = findHeader(records, "video id");
  if (found === null) {
    throw new TakeoutParseError("Playlist CSV has no 'Video ID' header row");
  }
  const idCol = found.header.indexOf("video id");
  const tsCol = found.header.findIndex((cell) => PLAYLIST_TIME_COLUMNS.includes(cell));

  const result: TakeoutParseResult<TakeoutVideoRow> = { rows: [], skipped: {} };
  for (const record of records.slice(found.index + 1)) {
    if (isBlank(record)) {
      continue;
    }
    const videoId = parseVideoId(record[idCol] ?? "");
    if (videoId === null) {
      bump(result, "invalid-video-id");
      continue;
    }
    const ts = tsCol === -1 ? null : parseTakeoutTimestamp(record[tsCol]);
    result.rows.push({ videoId, ts });
  }
  return result;
}

/**
 * Parse `subscriptions.csv` (`Channel Id,Channel Url,Channel Title`). A row
 * whose id cell is invalid falls back to a `/channel/UC...` URL in the URL
 * cell. Titles may contain commas and quotes (RFC 4180 quoting).
 *
 * Throws TakeoutParseError when no `Channel Id` header row exists.
 */
export function parseSubscriptionsCsv(text: string): TakeoutParseResult<TakeoutChannelRow> {
  const records = readCsv(text);
  const found = findHeader(records, "channel id");
  if (found === null) {
    throw new TakeoutParseError("Subscriptions CSV has no 'Channel Id' header row");
  }
  const idCol = found.header.indexOf("channel id");
  const urlCol = found.header.indexOf("channel url");
  const titleCol = found.header.indexOf("channel title");

  const result: TakeoutParseResult<TakeoutChannelRow> = { rows: [], skipped: {} };
  for (const record of records.slice(found.index + 1)) {
    if (isBlank(record)) {
      continue;
    }
    let channelId: string | null = (record[idCol] ?? "").trim();
    if (!CHANNEL_ID_RE.test(channelId)) {
      const ref = urlCol === -1 ? null : parseChannelRef(record[urlCol] ?? "");
      channelId = ref?.kind === "id" ? ref.value : null;
    }
    if (channelId === null) {
      bump(result, "invalid-channel-id");
      continue;
    }
    const title = titleCol === -1 ? "" : (record[titleCol] ?? "").trim();
    result.rows.push({ channelId, title });
  }
  return result;
}

/** Takeout CSVs that can sit next to playlists but are not playlists. */
const NON_PLAYLIST_CSVS = new Set([
  "playlists.csv",
  "comments.csv",
  "videos.csv",
  "video texts.csv",
  "video recordings.csv",
  "live chats.csv",
  "music library songs.csv",
  "music uploads.csv",
  "channel.csv",
  "channel feature data.csv",
  "channel community moderation settings.csv",
  "channel page settings.csv",
  "channel url configs.csv",
]);

/**
 * Decide which parser applies to a Takeout file, from its bare name or its
 * path inside the zip (`/` or `\` separators, any case). Watch Later and Liked
 * are recognised in both the `Watch later.csv` and `Watch later-videos.csv`
 * spellings. Returns null for files the importer does not use (search history,
 * comments, `playlists.csv`, the HTML history export, channel settings, ...).
 * Any other CSV is a playlist when it sits directly in a `playlists`
 * directory, or when it is a bare upload that is not a known non-playlist file.
 */
export function classifyTakeoutFile(name: string): TakeoutFileKind | null {
  const segments = name
    .trim()
    .split(/[\\/]+/)
    .filter((segment) => segment !== "");
  const base = segments.at(-1) ?? "";
  const lower = base.toLowerCase();

  if (lower === "watch-history.json") {
    return "history";
  }
  if (lower === "subscriptions.csv") {
    return "subscription";
  }
  if (!lower.endsWith(".csv")) {
    return null;
  }
  const stem = base
    .slice(0, -".csv".length)
    .replace(/-videos$/i, "")
    .trim();
  const lowerStem = stem.toLowerCase();
  if (lowerStem === "watch later") {
    return "watch_later";
  }
  if (lowerStem === "liked videos") {
    return "liked";
  }

  const dirs = segments.slice(0, -1);
  if (dirs.length > 0) {
    if (dirs.at(-1)?.toLowerCase() !== "playlists" || lower === "playlists.csv") {
      return null;
    }
  } else if (NON_PLAYLIST_CSVS.has(lower)) {
    return null;
  }
  return stem === "" ? null : `playlist:${stem}`;
}
