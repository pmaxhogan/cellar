import {
  DEFAULT_FILENAME_TEMPLATE,
  renderFilename,
  uniquify,
  type BulkDownloadEstimate,
  type BulkKind,
  type FilenameFields,
} from "@cellar/shared";
import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";
import type { Db } from "../db/db.ts";
import { DomainError } from "./errors.ts";
import { currentMediaFor, resolveMediaPath, type MediaRecord } from "./videoFiles.ts";
import { getVideo } from "./videos.ts";

/**
 * Bulk download: pick the files for a selection of videos, name them with the
 * shared filename template, and stream them as one ZIP.
 *
 * The ZIP writer is hand rolled because store mode is simple and owning it
 * buys two things: the archive is produced chunk by chunk as the client reads
 * (never buffered), and its exact length is known before the first byte, so
 * the response carries a Content-Length and the browser shows real progress.
 * Entries use data descriptors (the CRC is computed while streaming) and
 * switch to ZIP64 records only when a size or offset needs them.
 */

// ---------------------------------------------------------------------------
// ZIP (store only, ZIP64 when needed). PKWARE APPNOTE 6.3.x.
// ---------------------------------------------------------------------------

export interface ZipEntry {
  /** UTF-8 name inside the archive. */
  name: string;
  /** Exact byte length; a file whose length differs at read time aborts the stream. */
  size: number;
  source: { path: string } | { data: Buffer };
}

/** Field limits, injectable so tests can force the ZIP64 paths with small files. */
export interface ZipLimits {
  /** Sizes and offsets at or above this use ZIP64 fields. */
  u32: number;
  /** An entry count at or above this uses the ZIP64 end record. */
  u16: number;
}

export const ZIP_LIMITS: ZipLimits = { u32: 0xffffffff, u16: 0xffff };

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_ZIP64_END = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_END = 0x06054b50;
/** Bit 3: sizes and CRC follow the data. Bit 11: names are UTF-8. */
const FLAGS = 0x0008 | 0x0800;
const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
/** Made by UNIX (3), spec 4.5, so the external attributes carry a file mode. */
const MADE_BY = (3 << 8) | VERSION_ZIP64;
const FILE_MODE = 0o100644;

interface PlannedEntry {
  entry: ZipEntry;
  name: Buffer;
  offset: number;
  zip64Size: boolean;
  zip64Offset: boolean;
}

export interface ZipPlan {
  entries: PlannedEntry[];
  centralOffset: number;
  centralSize: number;
  zip64End: boolean;
  /** Exact archive length in bytes. */
  total: number;
}

function centralExtraLength(entry: PlannedEntry): number {
  if (!entry.zip64Size && !entry.zip64Offset) {
    return 0;
  }
  return 4 + (entry.zip64Size ? 16 : 0) + (entry.zip64Offset ? 8 : 0);
}

/** Lay the archive out: every offset and the total length, before any byte is read. */
export function planZip(entries: readonly ZipEntry[], limits: ZipLimits = ZIP_LIMITS): ZipPlan {
  const planned: PlannedEntry[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const zip64Size = entry.size >= limits.u32;
    planned.push({ entry, name, offset, zip64Size, zip64Offset: offset >= limits.u32 });
    offset += 30 + name.length + (zip64Size ? 20 : 0) + entry.size + (zip64Size ? 24 : 16);
  }
  const centralOffset = offset;
  const centralSize = planned.reduce(
    (sum, entry) => sum + 46 + entry.name.length + centralExtraLength(entry),
    0,
  );
  const zip64End =
    planned.length >= limits.u16 || centralOffset >= limits.u32 || centralSize >= limits.u32;
  return {
    entries: planned,
    centralOffset,
    centralSize,
    zip64End,
    total: centralOffset + centralSize + (zip64End ? 56 + 20 : 0) + 22,
  };
}

/** MS-DOS date and time (UTC fields, 2 s resolution, 1980 at the earliest). */
export function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function u64(buffer: Buffer, value: number, at: number): void {
  buffer.writeBigUInt64LE(BigInt(value), at);
}

function localHeader(entry: PlannedEntry, dos: { time: number; date: number }): Buffer {
  const extra = entry.zip64Size ? 20 : 0;
  const out = Buffer.alloc(30 + entry.name.length + extra);
  out.writeUInt32LE(SIG_LOCAL, 0);
  out.writeUInt16LE(entry.zip64Size || entry.zip64Offset ? VERSION_ZIP64 : VERSION_DEFAULT, 4);
  out.writeUInt16LE(FLAGS, 6);
  out.writeUInt16LE(0, 8); // stored
  out.writeUInt16LE(dos.time, 10);
  out.writeUInt16LE(dos.date, 12);
  // CRC and sizes are zero here and follow the data in the descriptor (bit 3).
  out.writeUInt32LE(0, 14);
  out.writeUInt32LE(entry.zip64Size ? 0xffffffff : 0, 18);
  out.writeUInt32LE(entry.zip64Size ? 0xffffffff : 0, 22);
  out.writeUInt16LE(entry.name.length, 26);
  out.writeUInt16LE(extra, 28);
  entry.name.copy(out, 30);
  if (entry.zip64Size) {
    const at = 30 + entry.name.length;
    out.writeUInt16LE(0x0001, at);
    out.writeUInt16LE(16, at + 2);
    // Both sizes stay zero in the local record; the descriptor carries them.
  }
  return out;
}

function descriptor(entry: PlannedEntry, crc: number): Buffer {
  if (entry.zip64Size) {
    const out = Buffer.alloc(24);
    out.writeUInt32LE(SIG_DESCRIPTOR, 0);
    out.writeUInt32LE(crc, 4);
    u64(out, entry.entry.size, 8);
    u64(out, entry.entry.size, 16);
    return out;
  }
  const out = Buffer.alloc(16);
  out.writeUInt32LE(SIG_DESCRIPTOR, 0);
  out.writeUInt32LE(crc, 4);
  out.writeUInt32LE(entry.entry.size, 8);
  out.writeUInt32LE(entry.entry.size, 12);
  return out;
}

function centralHeader(entry: PlannedEntry, crc: number, dos: { time: number; date: number }) {
  const extra = centralExtraLength(entry);
  const out = Buffer.alloc(46 + entry.name.length + extra);
  const size = entry.zip64Size ? 0xffffffff : entry.entry.size;
  out.writeUInt32LE(SIG_CENTRAL, 0);
  out.writeUInt16LE(MADE_BY, 4);
  out.writeUInt16LE(entry.zip64Size || entry.zip64Offset ? VERSION_ZIP64 : VERSION_DEFAULT, 6);
  out.writeUInt16LE(FLAGS, 8);
  out.writeUInt16LE(0, 10);
  out.writeUInt16LE(dos.time, 12);
  out.writeUInt16LE(dos.date, 14);
  out.writeUInt32LE(crc, 16);
  out.writeUInt32LE(size, 20);
  out.writeUInt32LE(size, 24);
  out.writeUInt16LE(entry.name.length, 28);
  out.writeUInt16LE(extra, 30);
  out.writeUInt16LE(0, 32); // comment length
  out.writeUInt16LE(0, 34); // disk number start
  out.writeUInt16LE(0, 36); // internal attributes
  out.writeUInt32LE((FILE_MODE << 16) >>> 0, 38);
  out.writeUInt32LE(entry.zip64Offset ? 0xffffffff : entry.offset, 42);
  entry.name.copy(out, 46);
  if (extra > 0) {
    let at = 46 + entry.name.length;
    out.writeUInt16LE(0x0001, at);
    out.writeUInt16LE(extra - 4, at + 2);
    at += 4;
    // Only the fields that are 0xFFFFFFFF above, in the order of spec 4.5.3.
    if (entry.zip64Size) {
      u64(out, entry.entry.size, at);
      u64(out, entry.entry.size, at + 8);
      at += 16;
    }
    if (entry.zip64Offset) {
      u64(out, entry.offset, at);
    }
  }
  return out;
}

function endRecords(plan: ZipPlan): Buffer {
  const count = plan.entries.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(Math.min(count, 0xffff), 8);
  end.writeUInt16LE(Math.min(count, 0xffff), 10);
  end.writeUInt32LE(plan.zip64End ? 0xffffffff : plan.centralSize, 12);
  end.writeUInt32LE(plan.zip64End ? 0xffffffff : plan.centralOffset, 16);
  if (!plan.zip64End) {
    return end;
  }
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  const record = Buffer.alloc(56);
  record.writeUInt32LE(SIG_ZIP64_END, 0);
  u64(record, 44, 4);
  record.writeUInt16LE(MADE_BY, 12);
  record.writeUInt16LE(VERSION_ZIP64, 14);
  u64(record, count, 24);
  u64(record, count, 32);
  u64(record, plan.centralSize, 40);
  u64(record, plan.centralOffset, 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
  u64(locator, plan.centralOffset + plan.centralSize, 8);
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([record, locator, end]);
}

async function* zipChunks(plan: ZipPlan, modified: Date): AsyncGenerator<Buffer> {
  const dos = dosDateTime(modified);
  const crcs: number[] = [];
  for (const entry of plan.entries) {
    yield localHeader(entry, dos);
    let crc = 0;
    let length = 0;
    const { source } = entry.entry;
    if ("data" in source) {
      crc = crc32(source.data);
      length = source.data.length;
      yield source.data;
    } else {
      for await (const chunk of createReadStream(source.path)) {
        const buffer = chunk as Buffer;
        crc = crc32(buffer, crc);
        length += buffer.length;
        yield buffer;
      }
    }
    if (length !== entry.entry.size) {
      throw new Error(`zip entry ${entry.entry.name} changed size while streaming`);
    }
    crcs.push(crc);
    yield descriptor(entry, crc);
  }
  for (const [index, entry] of plan.entries.entries()) {
    yield centralHeader(entry, crcs[index] ?? 0, dos);
  }
  yield endRecords(plan);
}

/** A readable that produces the archive as it is consumed. */
export function zipStream(plan: ZipPlan, modified: Date = new Date()): Readable {
  return Readable.from(zipChunks(plan, modified), { objectMode: false });
}

// ---------------------------------------------------------------------------
// Selection: which files a bulk download contains and what they are called.
// ---------------------------------------------------------------------------

const KINDS: Record<BulkKind, readonly MediaRecord["kind"][]> = {
  video: ["video"],
  audio: ["audio"],
  captions: ["captions"],
  all: ["video", "audio", "captions", "info"],
};

export interface BulkVideoRow {
  id: string;
  title: string | null;
  channel_title: string | null;
  upload_date: number | null;
  duration_s: number | null;
  source: string | null;
}

export interface BulkFile {
  name: string;
  size: number;
  source: ZipEntry["source"];
  videoId: string;
}

function isoDay(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString().slice(0, 10);
}

function fileSize(path: string): number | null {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

/** Template fields for a video's download filename (ext and resolution come from the file). */
export function videoFilenameFields(video: BulkVideoRow): FilenameFields {
  return {
    title: video.title,
    channel: video.channel_title,
    upload_date: isoDay(video.upload_date),
    id: video.id,
    source: video.source,
    duration: video.duration_s,
  };
}

/** The rows planBulkFiles names files from, by id. Unknown ids are absent. */
export function loadVideos(db: Db, ids: readonly string[]): Map<string, BulkVideoRow> {
  const out = new Map<string, BulkVideoRow>();
  for (let index = 0; index < ids.length; index += 500) {
    const chunk = ids.slice(index, index + 500);
    const rows = db.all<BulkVideoRow>(
      `SELECT v.id, v.title, c.title AS channel_title, v.upload_date, v.duration_s,
              (SELECT s.source FROM video_sources s WHERE s.video_id = v.id
                ORDER BY s.first_seen_at, s.id LIMIT 1) AS source
         FROM videos v LEFT JOIN channels c ON c.id = v.channel_id
        WHERE v.id IN (${chunk.map(() => "?").join(", ")})`,
      ...chunk,
    );
    for (const row of rows) {
      out.set(row.id, row);
    }
  }
  return out;
}

function sanitiseLang(lang: string | null): string {
  const clean = (lang ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return clean === "" ? "und" : clean;
}

/**
 * The files a bulk download of `ids` contains, in request order. A file the
 * database knows but the disk does not is skipped, so the archive never
 * promises bytes it cannot deliver. Video and audio are named by the
 * template; captions (`<stem>.<lang>.vtt`) and, for `all`, metadata
 * (`<stem>.metadata.json`) sit next to them. Names are unique
 * case-insensitively.
 */
export function planBulkFiles(
  db: Db,
  metaDir: string,
  input: { ids: readonly string[]; kind: BulkKind; template?: string | undefined },
): BulkFile[] {
  const template = input.template ?? DEFAULT_FILENAME_TEMPLATE;
  const videos = loadVideos(db, input.ids);
  const kinds = KINDS[input.kind];
  const media = currentMediaFor(db, [...videos.keys()], kinds);
  const byVideo = new Map<string, MediaRecord[]>();
  for (const row of media) {
    const list = byVideo.get(row.video_id) ?? [];
    list.push(row);
    byVideo.set(row.video_id, list);
  }
  const taken = new Set<string>();
  const files: BulkFile[] = [];
  const add = (videoId: string, name: string, size: number, source: ZipEntry["source"]) => {
    files.push({ videoId, name: uniquify(name, taken), size, source });
  };
  const onDisk = (record: MediaRecord): { path: string; size: number } | null => {
    let path: string;
    try {
      path = resolveMediaPath(db, metaDir, record);
    } catch {
      return null;
    }
    const size = fileSize(path);
    return size === null ? null : { path, size };
  };

  for (const id of input.ids) {
    const video = videos.get(id);
    if (video === undefined) {
      continue;
    }
    const fields = videoFilenameFields(video);
    const records = byVideo.get(id) ?? [];
    const firstOf = (kind: MediaRecord["kind"]) => records.find((r) => r.kind === kind);
    let stem: string | null = null;
    for (const kind of ["video", "audio"] as const) {
      const record = firstOf(kind);
      const file = record === undefined ? null : onDisk(record);
      if (record === undefined || file === null) {
        continue;
      }
      const ext = extname(record.rel_path).slice(1);
      const name = renderFilename(template, { ...fields, ext, resolution: record.height });
      stem ??= name.slice(0, name.length - (ext === "" ? 0 : ext.length + 1));
      add(id, name, file.size, { path: file.path });
    }
    const base = stem ?? renderFilename(template, { ...fields, ext: "" });
    const seenLangs = new Set<string>();
    for (const record of records.filter((r) => r.kind === "captions")) {
      const lang = sanitiseLang(record.lang);
      const file = seenLangs.has(lang) ? null : onDisk(record);
      if (file === null) {
        continue;
      }
      seenLangs.add(lang);
      add(id, `${base}.${lang}.vtt`, file.size, { path: file.path });
    }
    if (input.kind === "all") {
      const info = firstOf("info");
      const file = info === undefined ? null : onDisk(info);
      if (file !== null) {
        add(id, `${base}.metadata.json`, file.size, { path: file.path });
      } else {
        const data = Buffer.from(`${JSON.stringify(getVideo(db, id), null, 2)}\n`, "utf8");
        add(id, `${base}.metadata.json`, data.length, { data });
      }
    }
  }
  return files;
}

/** Bytes per "GB" in the bulk.warn_gb setting (decimal, as the UI labels it). */
export const GB = 1_000_000_000;

export function estimateBulk(files: readonly BulkFile[], warnGb: number): BulkDownloadEstimate {
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  return { files: files.length, bytes, warn: bytes > warnGb * GB };
}

/** `cellar-YYYY-MM-DD.zip` for the given instant (UTC). */
export function bulkArchiveName(now: Date): string {
  return `cellar-${now.toISOString().slice(0, 10)}.zip`;
}

/** Plan the archive for a set of files, or not_found when there is nothing to send. */
export function bulkZipPlan(files: readonly BulkFile[], limits: ZipLimits = ZIP_LIMITS): ZipPlan {
  if (files.length === 0) {
    throw new DomainError("not_found", "None of the selected videos has a file to download.");
  }
  return planZip(
    files.map((file) => ({ name: file.name, size: file.size, source: file.source })),
    limits,
  );
}
