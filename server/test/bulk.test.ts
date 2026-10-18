import AdmZip from "adm-zip";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import {
  bulkArchiveName,
  bulkZipPlan,
  dosDateTime,
  estimateBulk,
  GB,
  planBulkFiles,
  planZip,
  zipStream,
  type ZipEntry,
} from "../src/domain/bulk.ts";
import { DomainError } from "../src/domain/errors.ts";
import { createTempDb, type TempDb } from "./helpers.ts";
import { readZip } from "./zipReader.ts";
import {
  seedChannel,
  seedLocation,
  seedMedia,
  seedSource,
  seedVideo,
  T0,
  vid,
} from "./videoSeed.ts";

const CAFE = `Caf${String.fromCodePoint(0xe9)}`;
const WHEN = new Date(Date.UTC(2026, 9, 18, 13, 45, 31));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cellar-bulk-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function zipOf(entries: ZipEntry[], limits?: { u32: number; u16: number }) {
  const plan = planZip(entries, limits);
  const bytes = await buffer(zipStream(plan, WHEN));
  return { plan, bytes };
}

describe("zip writer", () => {
  it("streams a store-only archive whose length is known up front", async () => {
    const file = join(root, "big.bin");
    const content = Buffer.alloc(200_000, 7);
    content.write("hello", 1000);
    writeFileSync(file, content);
    const { plan, bytes } = await zipOf([
      { name: "a.txt", size: 5, source: { data: Buffer.from("hello") } },
      { name: `${CAFE} [x].webm`, size: content.length, source: { path: file } },
      { name: "empty.json", size: 0, source: { data: Buffer.alloc(0) } },
    ]);
    expect(bytes.length).toBe(plan.total);
    expect(plan.zip64End).toBe(false);

    const read = readZip(bytes);
    expect(read.map((e) => e.name)).toEqual(["a.txt", `${CAFE} [x].webm`, "empty.json"]);
    expect(read.every((e) => e.utf8 && !e.zip64 && e.mode === 0o100644)).toBe(true);
    expect(read[1]?.data.equals(content)).toBe(true);

    const adm = new AdmZip(bytes);
    expect(adm.getEntries().map((e) => e.entryName)).toEqual([
      "a.txt",
      `${CAFE} [x].webm`,
      "empty.json",
    ]);
    expect(adm.readAsText("a.txt")).toBe("hello");
    expect(adm.getEntry(`${CAFE} [x].webm`)?.getData().equals(content)).toBe(true);
  });

  it("switches to ZIP64 records when sizes, offsets or counts need them", async () => {
    const file = join(root, "f.bin");
    writeFileSync(file, "0123456789abcdef");
    const entries: ZipEntry[] = [
      { name: "small", size: 3, source: { data: Buffer.from("abc") } },
      { name: "large", size: 16, source: { path: file } },
      { name: "late", size: 2, source: { data: Buffer.from("zz") } },
    ];
    // Thresholds shrunk so a few bytes exercise every ZIP64 branch.
    const { plan, bytes } = await zipOf(entries, { u32: 10, u16: 2 });
    expect(plan.zip64End).toBe(true);
    expect(plan.entries.map((e) => [e.zip64Size, e.zip64Offset])).toEqual([
      [false, false],
      [true, true],
      [false, true],
    ]);
    expect(bytes.length).toBe(plan.total);
    const read = readZip(bytes);
    expect(read.map((e) => [e.name, e.data.toString(), e.zip64])).toEqual([
      ["small", "abc", false],
      ["large", "0123456789abcdef", true],
      ["late", "zz", true],
    ]);
  });

  it("produces the archive lazily as it is read", async () => {
    const file = join(root, "four-mb.bin");
    writeFileSync(file, Buffer.alloc(4 * 1024 * 1024, 1));
    const plan = planZip([{ name: "x.bin", size: 4 * 1024 * 1024, source: { path: file } }]);
    const stream = zipStream(plan);
    const iterator = stream[Symbol.asyncIterator]();
    const first = (await iterator.next()) as IteratorResult<Buffer>;
    expect(first.value.length).toBe(30 + "x.bin".length);
    // Only what the readable buffers ahead has been produced, not the file.
    expect(stream.readableLength).toBeLessThan(512 * 1024);
    await iterator.return?.();
    expect(stream.destroyed).toBe(true);
  });

  it("fails the stream when a file changes size after planning", async () => {
    const file = join(root, "shrinks.bin");
    writeFileSync(file, "1234");
    const plan = planZip([{ name: "x", size: 10, source: { path: file } }]);
    await expect(buffer(zipStream(plan))).rejects.toThrow(/changed size/);
  });

  it("encodes MS-DOS times", () => {
    expect(dosDateTime(WHEN)).toEqual({
      time: (13 << 11) | (45 << 5) | 15,
      date: (46 << 9) | (10 << 5) | 18,
    });
    expect(dosDateTime(new Date(0)).date).toBe((0 << 9) | (1 << 5) | 1);
  });

  it("names the archive by date", () => {
    expect(bulkArchiveName(WHEN)).toBe("cellar-2026-10-18.zip");
  });
});

describe("planBulkFiles", () => {
  let temp: TempDb;
  let db: Db;
  let meta: string;

  beforeEach(() => {
    temp = createTempDb();
    db = temp.db;
    meta = join(root, "meta");
    const media = join(root, "media");
    mkdirSync(join(media, "UC", "one"), { recursive: true });
    mkdirSync(join(meta, "UC", "one"), { recursive: true });
    const loc = seedLocation(db, "disk", media);
    seedChannel(db, "UCchan00000000000000000000", "The Channel");
    seedVideo(db, {
      id: vid("one"),
      channel_id: "UCchan00000000000000000000",
      title: "Same title",
      upload_date: Date.UTC(2025, 4, 6),
      duration_s: 65,
    });
    seedVideo(db, { id: vid("two"), title: "Same title" });
    seedVideo(db, { id: vid("three"), title: null });
    seedSource(db, vid("one"), "liked", null, T0);
    writeFileSync(join(media, "UC", "one", "v.webm"), "VIDEO");
    writeFileSync(join(media, "UC", "one", "a.m4a"), "AUDIO!");
    writeFileSync(join(meta, "UC", "one", "en.vtt"), "WEBVTT");
    writeFileSync(join(meta, "UC", "one", "info.json"), '{"id":"one"}');
    seedMedia(db, {
      video_id: vid("one"),
      kind: "video",
      rel_path: "UC/one/v.webm",
      location_id: loc,
      height: 1080,
    });
    seedMedia(db, {
      video_id: vid("one"),
      kind: "audio",
      rel_path: "UC/one/a.m4a",
      location_id: loc,
    });
    seedMedia(db, {
      video_id: vid("one"),
      kind: "captions",
      rel_path: "UC/one/en.vtt",
      lang: "en",
    });
    seedMedia(db, {
      video_id: vid("one"),
      kind: "captions",
      rel_path: "UC/one/gone.vtt",
      lang: "de",
    });
    seedMedia(db, { video_id: vid("one"), kind: "info", rel_path: "UC/one/info.json" });
    // "two" has a file of the same name, so the names must be made unique.
    writeFileSync(join(media, "UC", "one", "two.webm"), "VIDEO2");
    seedMedia(db, {
      video_id: vid("two"),
      kind: "video",
      rel_path: "UC/one/two.webm",
      location_id: loc,
    });
    seedMedia(db, {
      video_id: vid("two"),
      kind: "video",
      rel_path: "../escape.webm",
      location_id: loc,
      version: 0,
    });
    seedMedia(db, {
      video_id: vid("three"),
      kind: "captions",
      rel_path: "UC/one/en.vtt",
      lang: "e n",
    });
    // Same language once sanitised as the row above, and a row without a language.
    seedMedia(db, {
      video_id: vid("three"),
      kind: "captions",
      rel_path: "UC/one/en.vtt",
      lang: "en",
    });
    seedMedia(db, { video_id: vid("three"), kind: "captions", rel_path: "UC/one/en.vtt" });
    // A directory where a file should be is skipped; a file without an extension is kept.
    seedMedia(db, { video_id: vid("three"), kind: "video", rel_path: "UC/one", location_id: loc });
    writeFileSync(join(media, "UC", "one", "raw"), "RAW");
    seedMedia(db, {
      video_id: vid("three"),
      kind: "audio",
      rel_path: "UC/one/raw",
      location_id: loc,
    });
  });

  afterEach(() => {
    temp.close();
  });

  const names = (input: Parameters<typeof planBulkFiles>[2]) =>
    planBulkFiles(db, meta, input).map((file) => [file.name, file.size]);

  it("names video files with the template and makes them unique", () => {
    expect(names({ ids: [vid("one"), vid("two"), vid("nope")], kind: "video" })).toEqual([
      [`Same title [${vid("one")}].webm`, 5],
      [`Same title [${vid("two")}].webm`, 6],
    ]);
    expect(
      names({
        ids: [vid("one"), vid("two")],
        kind: "video",
        template: "{title} {resolution} {channel} {upload_date} {source} {duration}",
      }),
    ).toEqual([
      ["Same title 1080p The Channel 2025-05-06 liked 1m05s.webm", 5],
      ["Same title.webm", 6],
    ]);
    expect(names({ ids: [vid("one"), vid("two")], kind: "video", template: "{title}" })).toEqual([
      ["Same title.webm", 5],
      ["Same title (2).webm", 6],
    ]);
  });

  it("selects audio or captions alone", () => {
    expect(names({ ids: [vid("one")], kind: "audio" })).toEqual([
      [`Same title [${vid("one")}].m4a`, 6],
    ]);
    // The German captions row has no file on disk and is skipped.
    expect(names({ ids: [vid("one"), vid("three")], kind: "captions" })).toEqual([
      [`Same title [${vid("one")}].en.vtt`, 6],
      // No title: the template leaves "[id]"; the language is reduced to safe characters.
      [`[${vid("three")}].und.vtt`, 6],
      [`[${vid("three")}].en.vtt`, 6],
    ]);
    expect(names({ ids: [vid("three")], kind: "all" }).map(([name]) => name)).toEqual([
      `[${vid("three")}]`,
      `[${vid("three")}].und.vtt`,
      `[${vid("three")}].en.vtt`,
      `[${vid("three")}].metadata.json`,
    ]);
  });

  it("puts captions and metadata next to the media for all", () => {
    const files = planBulkFiles(db, meta, { ids: [vid("one"), vid("two")], kind: "all" });
    expect(files.map((file) => file.name)).toEqual([
      `Same title [${vid("one")}].webm`,
      `Same title [${vid("one")}].m4a`,
      `Same title [${vid("one")}].en.vtt`,
      `Same title [${vid("one")}].metadata.json`,
      `Same title [${vid("two")}].webm`,
      `Same title [${vid("two")}].metadata.json`,
    ]);
    // A stored info.json is served as is; otherwise the detail row is generated.
    expect(files[3]?.source).toEqual({ path: join(meta, "UC", "one", "info.json") });
    const generated = files[5]?.source;
    expect(generated !== undefined && "data" in generated).toBe(true);
    if (generated !== undefined && "data" in generated) {
      expect(JSON.parse(generated.data.toString("utf8"))).toMatchObject({ id: vid("two") });
      expect(files[5]?.size).toBe(generated.data.length);
    }
  });

  it("estimates and refuses an empty archive", () => {
    const files = planBulkFiles(db, meta, { ids: [vid("one")], kind: "video" });
    expect(estimateBulk(files, 20)).toEqual({ files: 1, bytes: 5, warn: false });
    expect(estimateBulk(files, 0)).toEqual({ files: 1, bytes: 5, warn: true });
    expect(estimateBulk([], 0)).toEqual({ files: 0, bytes: 0, warn: false });
    expect(GB).toBe(1e9);
    expect(() => bulkZipPlan([])).toThrow(DomainError);
    expect(bulkZipPlan(files).entries).toHaveLength(1);
  });
});
