import {
  filenameKey,
  renderFilename,
  uniquify,
  type BulkKind,
  type FilenameFields,
  type MediaRow,
  type VideoDetail,
} from "@cellar/shared";
import { ABORTED_PROBLEM, normalizeError, type ApiClient } from "../api/client.ts";
import { getVideo, mediaUrl, metadataUrl } from "../api/videos.ts";
import { effectiveTemplate, firstSource } from "./bulkDownload.ts";

/**
 * "Save to folder" for bulk downloads, via the File System Access API.
 *
 * Chromium only, so every entry point is feature-detected and the dialog falls
 * back to the ZIP. Structural types are declared locally rather than relying
 * on the DOM lib, which does not carry showDirectoryPicker in every TypeScript
 * version.
 *
 * Each file is streamed from the media endpoint straight into the file on disk
 * (response body piped into the writable), so a multi-gigabyte video never sits
 * in memory. Names follow the server's ZIP naming exactly: video and audio by
 * the template, captions as `<stem>.<lang>.vtt`, metadata as
 * `<stem>.metadata.json`, made unique case-insensitively against each other and
 * against what the folder already holds.
 */

export interface FsWritable {
  write: (data: Blob | BufferSource | string) => Promise<void>;
  close: () => Promise<void>;
  abort?: (reason?: unknown) => Promise<void>;
}

export interface FsFileHandle {
  createWritable: () => Promise<FsWritable | (WritableStream<Uint8Array> & FsWritable)>;
}

export interface FsDirectoryHandle {
  name: string;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<FsFileHandle>;
  keys?: () => AsyncIterable<string>;
}

type DirectoryPicker = (options?: {
  mode?: "read" | "readwrite";
  id?: string;
}) => Promise<FsDirectoryHandle>;

function picker(): DirectoryPicker | undefined {
  const candidate = (globalThis as unknown as { showDirectoryPicker?: unknown })
    .showDirectoryPicker;
  return typeof candidate === "function" ? (candidate as DirectoryPicker) : undefined;
}

/** Read at call time, so a test (or a polyfill) installed after import is seen. */
export function supportsDirectoryPicker(): boolean {
  return picker() !== undefined;
}

/** Null when unsupported or when the user dismissed the picker. */
export async function pickDirectory(): Promise<FsDirectoryHandle | null> {
  const pick = picker();
  if (pick === undefined) return null;
  try {
    return await pick({ mode: "readwrite", id: "cellar-bulk" });
  } catch {
    // The user dismissed the picker. Not an error worth surfacing.
    return null;
  }
}

export interface FolderFile {
  videoId: string;
  /** Name before uniquifying against the folder. */
  name: string;
  url: string;
  size: number | null;
}

const KINDS: Record<BulkKind, readonly MediaRow["kind"][]> = {
  video: ["video"],
  audio: ["audio"],
  captions: ["captions"],
  all: ["video", "audio", "captions", "info"],
};

function isoDay(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString().slice(0, 10);
}

function extOf(relPath: string): string {
  const base = relPath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1);
}

function sanitiseLang(lang: string | null): string {
  const clean = (lang ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return clean === "" ? "und" : clean;
}

export function detailFilenameFields(detail: VideoDetail): FilenameFields {
  return {
    title: detail.title,
    channel: detail.channel_title,
    upload_date: isoDay(detail.upload_date),
    id: detail.id,
    source: firstSource(detail),
    duration: detail.duration_s,
  };
}

/** The files one video contributes to a folder download, in the server's order. */
export function planVideoFiles(
  detail: VideoDetail,
  kind: BulkKind,
  template: string,
): FolderFile[] {
  const tpl = effectiveTemplate(template);
  const fields = detailFilenameFields(detail);
  const wanted = KINDS[kind];
  const current = detail.media.filter((row) => row.is_current && wanted.includes(row.kind));
  const firstOf = (k: MediaRow["kind"]) => current.find((row) => row.kind === k);
  const files: FolderFile[] = [];
  let stem: string | null = null;

  for (const k of ["video", "audio"] as const) {
    const row = firstOf(k);
    if (row === undefined) continue;
    const ext = extOf(row.rel_path);
    const name = renderFilename(tpl, { ...fields, ext, resolution: row.height });
    stem ??= name.slice(0, name.length - (ext === "" ? 0 : ext.length + 1));
    files.push({
      videoId: detail.id,
      name,
      url: mediaUrl(detail.id, row.id, true),
      size: row.size_bytes,
    });
  }
  const base = stem ?? renderFilename(tpl, { ...fields, ext: "" });
  const seenLangs = new Set<string>();
  for (const row of current.filter((candidate) => candidate.kind === "captions")) {
    const lang = sanitiseLang(row.lang);
    if (seenLangs.has(lang)) continue;
    seenLangs.add(lang);
    files.push({
      videoId: detail.id,
      name: `${base}.${lang}.vtt`,
      url: mediaUrl(detail.id, row.id, true),
      size: row.size_bytes,
    });
  }
  if (kind === "all") {
    files.push({
      videoId: detail.id,
      name: `${base}.metadata.json`,
      url: metadataUrl(detail.id),
      size: firstOf("info")?.size_bytes ?? null,
    });
  }
  return files;
}

export type FolderItemState = "pending" | "writing" | "done" | "failed" | "skipped";

export interface FolderItem {
  videoId: string;
  name: string;
  state: FolderItemState;
  bytes: number;
  size: number | null;
  error?: string;
}

export interface FolderDownloadResult {
  written: number;
  failed: number;
  cancelled: boolean;
  items: FolderItem[];
}

/** Names already in the folder, as uniquify keys; empty when the handle cannot list. */
export async function existingNames(directory: FsDirectoryHandle): Promise<Set<string>> {
  const taken = new Set<string>();
  if (directory.keys === undefined) return taken;
  try {
    for await (const name of directory.keys()) taken.add(filenameKey(name));
  } catch {
    // Listing is a nicety for not overwriting; a folder that refuses it still works.
  }
  return taken;
}

function isWritableStream(value: unknown): value is WritableStream<Uint8Array> {
  return (
    typeof WritableStream !== "undefined" &&
    value instanceof WritableStream &&
    typeof (value as WritableStream).getWriter === "function"
  );
}

/** Copy one response into a file, streaming when both ends allow it. */
async function writeResponse(
  response: Response,
  writable: FsWritable | (WritableStream<Uint8Array> & FsWritable),
  signal: AbortSignal | undefined,
  onBytes: (bytes: number) => void,
): Promise<void> {
  const body = response.body;
  if (body !== null && isWritableStream(writable)) {
    let bytes = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        onBytes(bytes);
        controller.enqueue(chunk);
      },
    });
    // pipeTo closes the file on success and aborts it on failure or cancel.
    await body.pipeThrough(counter).pipeTo(writable, { signal });
    return;
  }
  const blob = await response.blob();
  try {
    await writable.write(blob);
    onBytes(blob.size);
  } finally {
    await writable.close();
  }
}

const PROGRESS_INTERVAL_MS = 200;

export interface FolderDownloadOptions {
  api: ApiClient;
  ids: readonly string[];
  kind: BulkKind;
  template: string;
  directory: FsDirectoryHandle;
  signal?: AbortSignal;
  /** Called with the full item list whenever an item changes. */
  onProgress?: (items: FolderItem[]) => void;
}

/**
 * Download every file of the selection into `directory`, one at a time. A
 * failed file is recorded and skipped; cancelling stops at the current file.
 */
export async function downloadToFolder(
  options: FolderDownloadOptions,
): Promise<FolderDownloadResult> {
  const { api, ids, kind, template, directory, signal, onProgress } = options;
  const items: FolderItem[] = [];
  const emit = (): void => onProgress?.(items.map((item) => ({ ...item })));
  // A function, not a check narrowed once: the signal flips while awaiting.
  const aborted = (): boolean => signal?.aborted === true;
  const taken = await existingNames(directory);
  let written = 0;
  let failed = 0;

  const fail = (item: FolderItem, cause: unknown): void => {
    item.state = "failed";
    item.error = normalizeError(cause).message;
    failed += 1;
    emit();
  };

  for (const id of ids) {
    if (aborted()) break;
    let files: FolderFile[];
    try {
      files = planVideoFiles(await getVideo(api, id, signal), kind, template);
    } catch (cause) {
      if (normalizeError(cause).problem === ABORTED_PROBLEM) break;
      const item: FolderItem = { videoId: id, name: id, state: "pending", bytes: 0, size: null };
      items.push(item);
      fail(item, cause);
      continue;
    }
    if (files.length === 0) {
      items.push({ videoId: id, name: id, state: "skipped", bytes: 0, size: null });
      emit();
      continue;
    }
    for (const file of files) {
      if (aborted()) break;
      const item: FolderItem = {
        videoId: id,
        name: uniquify(file.name, taken),
        state: "writing",
        bytes: 0,
        size: file.size,
      };
      items.push(item);
      emit();
      try {
        const response = await api.raw(file.url, { method: "GET", signal });
        const handle = await directory.getFileHandle(item.name, { create: true });
        const writable = await handle.createWritable();
        let lastEmit = 0;
        await writeResponse(response, writable, signal, (bytes) => {
          item.bytes = bytes;
          // Chunks arrive many times a second; the progress list needs a few.
          const now = Date.now();
          if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
            lastEmit = now;
            emit();
          }
        });
        item.state = "done";
        written += 1;
        emit();
      } catch (cause) {
        if (aborted() || normalizeError(cause).problem === ABORTED_PROBLEM) {
          item.state = "failed";
          item.error = "Canceled.";
          emit();
          break;
        }
        fail(item, cause);
      }
    }
  }

  return { written, failed, cancelled: aborted(), items };
}
