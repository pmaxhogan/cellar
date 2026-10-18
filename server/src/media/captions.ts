import { mkdir, stat } from "node:fs/promises";
import { basename } from "node:path";
import { atomicRename, captionRel, listFiles, resolveRel, sha256File } from "./paths.ts";

/**
 * Captions sidecars. yt-dlp writes `<videoId>.<lang>.vtt` next to the media in
 * the in-flight dir; cellar keeps them as `<metaDir>/<channel>/<id>/<lang>.vtt`
 * (outside every quota, never reaped) with a `media(kind = captions)` row
 * whose location_id is NULL and whose rel_path is relative to metaDir.
 */

export interface CaptionFile {
  path: string;
  lang: string;
}

const LANG_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** `<id>.<lang>.vtt` files in `dir`. */
export async function findCaptionFiles(dir: string, videoId: string): Promise<CaptionFile[]> {
  const out: CaptionFile[] = [];
  const prefix = `${videoId}.`;
  for (const path of await listFiles(dir)) {
    const name = basename(path);
    if (!name.startsWith(prefix) || !name.endsWith(".vtt")) {
      continue;
    }
    const lang = name.slice(prefix.length, -".vtt".length);
    if (LANG_RE.test(lang)) {
      out.push({ path, lang });
    }
  }
  return out.sort((a, b) => a.lang.localeCompare(b.lang));
}

export interface InstalledCaption {
  lang: string;
  relPath: string;
  sizeBytes: number;
  sha256: string;
}

/** Move caption files into the meta tree (replacing older copies). */
export async function installCaptions(
  files: readonly CaptionFile[],
  metaDir: string,
  channelId: string | null,
  videoId: string,
): Promise<InstalledCaption[]> {
  const out: InstalledCaption[] = [];
  for (const file of files) {
    const rel = captionRel(channelId, videoId, file.lang);
    const target = resolveRel(metaDir, rel);
    await mkdir(resolveRel(metaDir, rel.slice(0, rel.lastIndexOf("/"))), { recursive: true });
    const sha256 = await sha256File(file.path);
    const { size } = await stat(file.path);
    await atomicRename(file.path, target);
    out.push({ lang: file.lang, relPath: rel, sizeBytes: size, sha256 });
  }
  return out;
}
