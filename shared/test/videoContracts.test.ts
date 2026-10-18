import { describe, expect, it } from "vitest";
import {
  BulkDownloadRequestSchema,
  COUNTER_FIELDS,
  isCounterField,
  TrashRequestSchema,
  VideoDetailSchema,
  VideoHistoryQuerySchema,
  VideoStatsQuerySchema,
  VideosListQuerySchema,
} from "../src/apiTypes.ts";

const A = "aaaaaaaaaaa";
const B = "bbbbbbbbbbb";

describe("VideosListQuerySchema", () => {
  it("applies defaults and leaves sort open for relevance", () => {
    expect(VideosListQuerySchema.parse({})).toEqual({ page: 1, perPage: 50, dir: "desc" });
  });

  it("reads lists from repeats, commas and single values, dropping empties", () => {
    expect(VideosListQuerySchema.parse({ source: ["liked", "history,liked"] }).source).toEqual([
      "liked",
      "history",
      "liked",
    ]);
    expect(VideosListQuerySchema.parse({ type: "short" }).type).toEqual(["short"]);
    expect(VideosListQuerySchema.parse({ status: " , " }).status).toBeUndefined();
    expect(VideosListQuerySchema.parse({ source: "" }).source).toBeUndefined();
  });

  it("reads instants as epoch ms or UTC dates", () => {
    const parsed = VideosListQuerySchema.parse({ date_from: "2026-01-02", date_to: "2026-01-02" });
    expect(parsed.date_from).toBe(Date.UTC(2026, 0, 2));
    expect(parsed.date_to).toBe(Date.UTC(2026, 0, 3) - 1);
    expect(VideoStatsQuerySchema.parse({ from: "12", to: 34 })).toEqual({ from: 12, to: 34 });
    expect(() => VideoStatsQuerySchema.parse({ from: "2026-13-45" })).toThrow();
  });
});

describe("id lists", () => {
  it("accepts arrays, single strings and comma lists, deduped", () => {
    expect(TrashRequestSchema.parse({ ids: [A, ` ${B} `, A] }).ids).toEqual([A, B]);
    expect(TrashRequestSchema.parse({ ids: `${A},${B}` }).ids).toEqual([A, B]);
    expect(BulkDownloadRequestSchema.parse({ ids: A })).toEqual({ ids: [A], kind: "video" });
  });

  it("rejects anything that is not a list of video ids", () => {
    expect(() => TrashRequestSchema.parse({ ids: 5 })).toThrow();
    expect(() => TrashRequestSchema.parse({ ids: [5] })).toThrow();
    expect(() => TrashRequestSchema.parse({ ids: "" })).toThrow();
    expect(() => BulkDownloadRequestSchema.parse({ ids: [A], template: "  " })).toThrow();
  });
});

describe("history counters", () => {
  it("names exactly the four tracked counters", () => {
    expect([...COUNTER_FIELDS]).toEqual(["views", "likes", "comments", "ryd_dislikes"]);
    expect(isCounterField("views")).toBe(true);
    expect(isCounterField("ryd_dislikes")).toBe(true);
    expect(isCounterField("title")).toBe(false);
    expect(isCounterField("ryd_ratio")).toBe(false);
  });

  it("parses the counters flag on the history query", () => {
    expect(VideoHistoryQuerySchema.parse({})).toEqual({ page: 1, perPage: 50 });
    expect(VideoHistoryQuerySchema.parse({ counters: "false" }).counters).toBe(false);
    expect(VideoHistoryQuerySchema.parse({ counters: "0" }).counters).toBe(false);
    expect(VideoHistoryQuerySchema.parse({ counters: "true" }).counters).toBe(true);
    expect(() => VideoHistoryQuerySchema.parse({ counters: "maybe" })).toThrow();
  });
});

describe("VideoDetailSchema previous_titles", () => {
  it("requires a title and changed_at on every entry", () => {
    const entry = VideoDetailSchema.shape.previous_titles.element;
    expect(entry.parse({ title: "Old", changed_at: 5 })).toEqual({ title: "Old", changed_at: 5 });
    expect(() => entry.parse({ title: "Old" })).toThrow();
    expect(() => entry.parse({ title: null, changed_at: 5 })).toThrow();
  });
});
