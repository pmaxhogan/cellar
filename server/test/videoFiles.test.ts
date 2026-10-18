import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { text } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { DomainError } from "../src/domain/errors.ts";
import {
  contentTypeFor,
  currentMedia,
  currentMediaFor,
  getMediaRecord,
  mediaRoot,
  openRangeStream,
  parseRange,
  pickThumbnail,
  realPathWithin,
  resolveMediaPath,
  resolveUnder,
  thumbnailPath,
  type RangeResult,
} from "../src/domain/videoFiles.ts";
import { createTempDb, type TempDb } from "./helpers.ts";
import { seedLocation, seedMedia, seedThumbnail, seedVideo, T0, vid } from "./videoSeed.ts";

let temp: TempDb;
let db: Db;
let root: string;

beforeEach(() => {
  temp = createTempDb();
  db = temp.db;
  root = mkdtempSync(join(tmpdir(), "cellar-files-"));
});

afterEach(() => {
  temp.close();
  rmSync(root, { recursive: true, force: true });
});

describe("resolveUnder", () => {
  it("joins a relative path under the root", () => {
    expect(resolveUnder(root, "UCx/abc/abc.webm")).toBe(resolve(root, "UCx/abc/abc.webm"));
  });

  it("refuses anything that could leave the root", () => {
    for (const rel of [
      "",
      "../outside.webm",
      "a/../../outside",
      "a/..",
      "..",
      "a\\..\\..\\b",
      "nul\0byte",
      "/etc/passwd",
      resolve(root, "..", "sibling"),
    ]) {
      expect(resolveUnder(root, rel), rel).toBeNull();
    }
    // The root itself is not a file inside it.
    expect(resolveUnder(root, ".")).toBeNull();
  });

  it("accepts an absolute path under the root only when allowed", () => {
    const inside = resolve(root, "t/x.jpg");
    expect(resolveUnder(root, inside)).toBeNull();
    expect(resolveUnder(root, inside, { allowAbsolute: true })).toBe(inside);
    expect(resolveUnder(root, resolve(root, "..", "x.jpg"), { allowAbsolute: true })).toBeNull();
  });
});

describe("realPathWithin", () => {
  it("follows symlinks out of the root", () => {
    const outside = mkdtempSync(join(tmpdir(), "cellar-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "x");
      mkdirSync(join(root, "in"));
      writeFileSync(join(root, "in", "ok.txt"), "y");
      // A junction needs no privileges on Windows and is a plain symlink elsewhere.
      symlinkSync(outside, join(root, "link"), "junction");
      const sneaky = resolveUnder(root, "link/secret.txt");
      expect(sneaky).not.toBeNull();
      expect(realPathWithin(root, sneaky ?? "")).toBe(false);
      expect(realPathWithin(root, join(root, "in", "ok.txt"))).toBe(true);
      // A missing file is left for the open to report.
      expect(realPathWithin(root, join(root, "missing"))).toBe(true);
      expect(realPathWithin(join(root, "no-root"), join(root, "in", "ok.txt"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("resolveMediaPath", () => {
  beforeEach(() => {
    seedVideo(db, { id: vid("m") });
  });

  it("resolves under the location or the meta dir", () => {
    const loc = seedLocation(db, "disk", join(root, "media"));
    const meta = join(root, "meta");
    expect(resolveMediaPath(db, meta, { location_id: loc, rel_path: "UC/m/m.webm" })).toBe(
      resolve(root, "media", "UC/m/m.webm"),
    );
    expect(resolveMediaPath(db, meta, { location_id: null, rel_path: "UC/m/en.vtt" })).toBe(
      resolve(meta, "UC/m/en.vtt"),
    );
    expect(mediaRoot(db, meta, null)).toBe(meta);
  });

  it("is not_found for an escape or a missing location", () => {
    expect(() =>
      resolveMediaPath(db, root, { location_id: null, rel_path: "../../etc/passwd" }),
    ).toThrow(DomainError);
    expect(() => resolveMediaPath(db, root, { location_id: 999, rel_path: "a.webm" })).toThrow(
      DomainError,
    );
  });

  it("looks media rows up by video and kind", () => {
    const first = seedMedia(db, {
      video_id: vid("m"),
      kind: "captions",
      rel_path: "en.vtt",
      lang: "en",
    });
    const newer = seedMedia(db, {
      video_id: vid("m"),
      kind: "captions",
      rel_path: "en2.vtt",
      lang: "en",
      version: 2,
    });
    seedMedia(db, { video_id: vid("m"), kind: "captions", rel_path: "de.vtt", lang: "de" });
    seedMedia(db, { video_id: vid("m"), kind: "info", rel_path: "info.json" });
    expect(getMediaRecord(db, vid("m"), first).rel_path).toBe("en.vtt");
    expect(() => getMediaRecord(db, vid("other"), first)).toThrow(DomainError);
    expect(currentMedia(db, vid("m"), "captions", "en")?.id).toBe(newer);
    expect(currentMedia(db, vid("m"), "info")?.rel_path).toBe("info.json");
    expect(currentMedia(db, vid("m"), "video")).toBeUndefined();
    expect(currentMediaFor(db, [vid("m")], ["captions"]).map((m) => m.rel_path)).toEqual([
      "en2.vtt",
      "de.vtt",
      "en.vtt",
    ]);
    expect(currentMediaFor(db, [], ["video"])).toEqual([]);
    expect(currentMediaFor(db, [vid("m")], [])).toEqual([]);
  });
});

describe("parseRange", () => {
  it("parses single byte ranges", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=990-5000", 1000)).toEqual({ start: 990, end: 999 });
  });

  it("reports unsatisfiable ranges", () => {
    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-0", 0)).toBe("unsatisfiable");
    expect(parseRange("bytes=-10", 0)).toBe("unsatisfiable");
  });

  it("ignores absent, malformed and multi ranges", () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange("bytes=-", 10)).toBeNull();
    expect(parseRange("bytes=5-2", 10)).toBeNull();
    expect(parseRange("items=0-1", 10)).toBeNull();
    expect(parseRange("bytes=0-1,3-4", 10)).toBeNull();
  });
});

async function bodyOf(result: RangeResult): Promise<string> {
  if (result.stream === null) {
    throw new Error("no stream");
  }
  return text(result.stream);
}

describe("openRangeStream", () => {
  let file: string;

  beforeEach(() => {
    file = join(root, "clip.webm");
    writeFileSync(file, "0123456789");
  });

  it("serves the whole file", async () => {
    const result = openRangeStream(file, undefined);
    expect(result.status).toBe(200);
    expect(result.headers).toMatchObject({
      "content-type": "video/webm",
      "accept-ranges": "bytes",
      "content-length": "10",
    });
    expect(await bodyOf(result)).toBe("0123456789");
  });

  it("serves a partial range", async () => {
    const result = openRangeStream(file, "bytes=2-5");
    expect(result.status).toBe(206);
    expect(result.headers).toMatchObject({
      "content-length": "4",
      "content-range": "bytes 2-5/10",
    });
    expect(await bodyOf(result)).toBe("2345");
  });

  it("answers 416 and HEAD without a stream", () => {
    const bad = openRangeStream(file, "bytes=50-");
    expect(bad.status).toBe(416);
    expect(bad.headers["content-range"]).toBe("bytes */10");
    expect(bad.stream).toBeNull();
    expect(openRangeStream(file, undefined, { head: true }).stream).toBeNull();
    expect(openRangeStream(file, "bytes=0-0", { head: true })).toMatchObject({
      status: 206,
      stream: null,
    });
  });

  it("is not_found for a missing file or a directory", () => {
    expect(() => openRangeStream(join(root, "nope"), undefined)).toThrow(DomainError);
    expect(() => openRangeStream(root, undefined)).toThrow(DomainError);
  });

  it("maps extensions to media types", () => {
    expect(contentTypeFor("a.MP4")).toBe("video/mp4");
    expect(contentTypeFor("a.mkv")).toBe("video/x-matroska");
    expect(contentTypeFor("a.m4a")).toBe("audio/mp4");
    expect(contentTypeFor("a.opus")).toBe("audio/ogg");
    expect(contentTypeFor("a.ogg")).toBe("audio/ogg");
    expect(contentTypeFor("a.vtt")).toBe("text/vtt; charset=utf-8");
    expect(contentTypeFor("a.jpg")).toBe("image/jpeg");
    expect(contentTypeFor("info.json")).toBe("application/json; charset=utf-8");
    expect(contentTypeFor("a.bin")).toBe("application/octet-stream");
    expect(contentTypeFor("noext")).toBe("application/octet-stream");
  });
});

describe("thumbnails", () => {
  it("picks the requested variant, else the best fallback", () => {
    const rows = [
      { variant: "hqdefault", n: 1 },
      { variant: "mqdefault", n: 2 },
      { variant: "hqdefault", n: 3 },
    ];
    expect(pickThumbnail(rows, "hqdefault")?.n).toBe(1);
    expect(pickThumbnail(rows, "maxresdefault")?.n).toBe(1);
    expect(pickThumbnail(rows, "best")?.n).toBe(1);
    expect(pickThumbnail(rows, "mqdefault")?.n).toBe(2);
    expect(pickThumbnail([{ variant: "x" }], "best")).toBeUndefined();
    expect(pickThumbnail([], "default")).toBeUndefined();
  });

  it("resolves the newest stored row of a variant under the meta dir", () => {
    const meta = join(root, "meta");
    seedVideo(db, { id: vid("t") });
    seedThumbnail(db, vid("t"), "sddefault", "s1", "UC/t/thumbnails/sddefault-s1.jpg", T0);
    seedThumbnail(db, vid("t"), "sddefault", "s2", "UC/t/thumbnails/sddefault-s2.jpg", T0 + 5);
    seedThumbnail(db, vid("t"), "default", "d1", join(meta, "UC/t/thumbnails/default-d1.jpg"), T0);
    seedThumbnail(db, vid("t"), "hqdefault", "h1", "../../escape.jpg", T0);

    expect(thumbnailPath(db, meta, vid("t"), "maxresdefault")).toEqual({
      variant: "sddefault",
      sha256: "s2",
      path: resolve(meta, "UC/t/thumbnails/sddefault-s2.jpg"),
    });
    expect(thumbnailPath(db, meta, vid("t"), "sddefault", "s1")?.sha256).toBe("s1");
    expect(thumbnailPath(db, meta, vid("t"), "sddefault", "zz")).toBeUndefined();
    // Absolute paths are fine when they are under the meta dir.
    expect(thumbnailPath(db, meta, vid("t"), "default")?.path).toBe(
      resolve(meta, "UC/t/thumbnails/default-d1.jpg"),
    );
    // A stored path that escapes reads as missing rather than falling through.
    expect(thumbnailPath(db, meta, vid("t"), "hqdefault")).toBeUndefined();
    expect(thumbnailPath(db, meta, vid("none"), "best")).toBeUndefined();
  });
});
