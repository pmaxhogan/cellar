import AdmZip from "adm-zip";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";

/**
 * Synthetic Google Takeout exports for the importer tests: the real layout of
 * a `takeout-<date>-001.tgz` (history JSON, one CSV per playlist including
 * Watch later and Liked videos, subscriptions.csv, the playlists.csv index
 * and search history), public video ids only. Non-ASCII playlist names are
 * built with String.fromCodePoint so the source stays ASCII.
 */

export const ROOT = "Takeout/YouTube and YouTube Music";

export const RICK = "dQw4w9WgXcQ";
export const ZOO = "jNQXAC9IVRw";
export const GANGNAM = "9bZkp7q19f0";
export const DESPACITO = "kJQP7kiw5Fk";
export const UPTOWN = "OPf0YbXqDm0";
export const SEE_YOU = "RgKAFK5djSk";

export const RICK_CHANNEL = "UCuAXFkgsw1L7xaCfnd5JJOw";
export const DEV_CHANNEL = "UC_x5XG1OV2P6uZZ5FSM9Ttw";

/** "Road trip <car emoji> <em dash> 2024": a playlist name that must round-trip. */
export const EMOJI_PLAYLIST = `Road trip ${String.fromCodePoint(0x1f697)} ${String.fromCodePoint(0x2014)} 2024`;

export const T_RICK_LATE = Date.UTC(2024, 2, 2, 10, 0, 0);
export const T_RICK_EARLY = Date.UTC(2023, 0, 1, 0, 0, 0);
export const T_ZOO = Date.UTC(2022, 4, 5, 5, 5, 5);
export const T_WL = Date.UTC(2024, 0, 1);
export const T_LIKED = Date.UTC(2023, 5, 1);

export function historyJson(): string {
  return JSON.stringify([
    {
      header: "YouTube",
      title: "Watched a song",
      titleUrl: `https://www.youtube.com/watch?v=${RICK}`,
      time: new Date(T_RICK_LATE).toISOString(),
    },
    {
      header: "YouTube",
      title: "Watched a song again",
      titleUrl: `https://www.youtube.com/watch?v=${RICK}`,
      time: new Date(T_RICK_EARLY).toISOString(),
    },
    {
      header: "YouTube",
      title: "Watched the zoo",
      titleUrl: `https://www.youtube.com/watch?v=${ZOO}`,
      time: new Date(T_ZOO).toISOString(),
    },
    {
      header: "YouTube",
      title: "Watched an ad",
      titleUrl: `https://www.youtube.com/watch?v=${UPTOWN}`,
      time: "2024-01-01T00:00:00Z",
      details: [{ name: "From Google Ads" }],
    },
    {
      header: "YouTube",
      title: "Watched a video that has been removed",
      time: "2021-01-01T00:00:00Z",
    },
  ]);
}

export function playlistCsv(rows: readonly [string, number][]): string {
  const lines = ["Video ID,Playlist Video Creation Timestamp"];
  for (const [id, ts] of rows) {
    lines.push(`${id},${new Date(ts).toISOString().replace("Z", "+00:00")}`);
  }
  return `${lines.join("\n")}\n`;
}

export function subscriptionsCsv(): string {
  return [
    "Channel Id,Channel Url,Channel Title",
    `${RICK_CHANNEL},http://www.youtube.com/channel/${RICK_CHANNEL},Rick Astley`,
    `${DEV_CHANNEL},http://www.youtube.com/channel/${DEV_CHANNEL},"Developers, Google"`,
    "",
  ].join("\n");
}

export interface FixtureFile {
  name: string;
  data: string;
}

/** The files of one export, at their archive paths. */
export function takeoutFiles(
  options: { htmlHistory?: boolean; emoji?: boolean } = {},
): FixtureFile[] {
  const files: FixtureFile[] = [
    options.htmlHistory === true
      ? {
          name: `${ROOT}/history/watch-history.html`,
          data: "<html><body><div>Watched a song</div></body></html>",
        }
      : { name: `${ROOT}/history/watch-history.json`, data: historyJson() },
    { name: `${ROOT}/history/search-history.json`, data: "[]" },
    { name: `${ROOT}/playlists/playlists.csv`, data: "Playlist ID,Playlist Title (Original)\n" },
    { name: `${ROOT}/playlists/Watch later-videos.csv`, data: playlistCsv([[GANGNAM, T_WL]]) },
    {
      name: `${ROOT}/playlists/Liked videos-videos.csv`,
      data: playlistCsv([[DESPACITO, T_LIKED]]),
    },
    { name: `${ROOT}/subscriptions/subscriptions.csv`, data: subscriptionsCsv() },
  ];
  files.push({
    name: `${ROOT}/playlists/${options.emoji === false ? "Road trip" : EMOJI_PLAYLIST}-videos.csv`,
    data: playlistCsv([
      [SEE_YOU, T_WL],
      [UPTOWN, T_WL],
    ]),
  });
  return files;
}

// ---------------------------------------------------------------------------
// Archives
// ---------------------------------------------------------------------------

export function buildZip(files: readonly FixtureFile[]): Buffer {
  const zip = new AdmZip();
  for (const file of files) {
    zip.addFile(file.name, Buffer.from(file.data, "utf8"));
  }
  return zip.toBuffer();
}

export interface TarEntry {
  name: string;
  data?: string;
  /** "0" file (default), "2" symlink, "5" directory. */
  type?: "0" | "2" | "5";
  linkname?: string;
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/** One ustar header block. Names over 100 bytes are split into prefix/name at a `/`. */
function tarHeader(entry: TarEntry, size: number): Buffer {
  const header = Buffer.alloc(512, 0);
  let name = Buffer.from(entry.name, "utf8");
  let prefix = Buffer.alloc(0);
  if (name.length > 100) {
    const cut = entry.name.lastIndexOf("/", entry.name.length - 1);
    prefix = Buffer.from(entry.name.slice(0, cut), "utf8");
    name = Buffer.from(entry.name.slice(cut + 1), "utf8");
  }
  name.copy(header, 0);
  header.write(entry.type === "5" ? "0000755\0" : "0000644\0", 100, "ascii");
  header.write(octal(0, 8), 108, "ascii");
  header.write(octal(0, 8), 116, "ascii");
  header.write(octal(size, 12), 124, "ascii");
  header.write(octal(1_700_000_000, 12), 136, "ascii");
  header.write("        ", 148, "ascii");
  header.write(entry.type ?? "0", 156, "ascii");
  if (entry.linkname !== undefined) {
    header.write(entry.linkname, 157, "utf8");
  }
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  prefix.copy(header, 345);
  let sum = 0;
  for (const byte of header) {
    sum += byte;
  }
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

/** A gzipped ustar archive, built by hand so every platform gets the same bytes. */
export function buildTgz(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(
      entry.type === undefined || entry.type === "0" ? (entry.data ?? "") : "",
    );
    blocks.push(tarHeader(entry, data.length));
    if (data.length > 0) {
      blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

/** True when a system tar is on PATH (the extraction under test needs one). */
export function hasSystemTar(): boolean {
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Multipart
// ---------------------------------------------------------------------------

export interface UploadPart {
  filename: string;
  data: string | Buffer;
}

/** A multipart/form-data body and its content-type, as a browser would send it. */
export async function multipartBody(
  parts: readonly UploadPart[],
  fields: Record<string, string> = {},
): Promise<{ body: Buffer; contentType: string }> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  for (const part of parts) {
    const bytes = typeof part.data === "string" ? Buffer.from(part.data, "utf8") : part.data;
    form.append("files", new Blob([new Uint8Array(bytes)]), part.filename);
  }
  const response = new Response(form);
  const contentType = response.headers.get("content-type") ?? "";
  return { body: Buffer.from(await response.arrayBuffer()), contentType };
}
