import { describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../../src/api/client.ts";
import { runBulkJobs } from "../../src/components/videos/bulkJobs.ts";
import {
  fieldLabel,
  formatChangeValue,
  isCounterField,
  splitHistory,
  statsChartData,
  statsChartOptions,
} from "../../src/components/videos/history.ts";
import {
  formatDay,
  priorityLabel,
  sourceChip,
  sourceLabel,
  videoStatus,
  watchUrl,
} from "../../src/components/videos/videoDisplay.ts";
import { change, ID, idFor, point } from "./fixtures.ts";

describe("video display helpers", () => {
  it("derives the status badge", () => {
    const at = (privacy: string | null, gone: number | null = null) =>
      videoStatus({ privacy, gone_since: gone });
    expect(at("public")).toEqual({ label: "public", severity: "success" });
    expect(at("unlisted")).toEqual({ label: "unlisted", severity: "info" });
    expect(at("private")).toEqual({ label: "private", severity: "warn" });
    expect(at("removed").label).toBe("gone");
    expect(at("unavailable").label).toBe("gone");
    expect(at("public", 5)).toEqual({ label: "gone", severity: "danger" });
    expect(at(null)).toEqual({ label: "unknown", severity: "secondary" });
    expect(at("members_only")).toEqual({ label: "members_only", severity: "secondary" });
  });

  it("labels priorities, sources and days", () => {
    expect(priorityLabel(null)).toBe("-");
    expect(priorityLabel(-1)).toBe("keep forever");
    expect(priorityLabel(0)).toBe("trashed");
    expect(priorityLabel(12)).toBe("12");
    expect(sourceLabel("watch_later")).toBe("Watch later");
    expect(sourceLabel("mystery")).toBe("mystery");
    const accounts = new Map([[1, "main"]]);
    expect(sourceChip({ source: "liked", account_id: 1 }, accounts)).toBe("Liked (main)");
    expect(sourceChip({ source: "liked", account_id: 9 }, accounts)).toBe("Liked (account 9)");
    expect(sourceChip({ source: "channel", account_id: null }, accounts)).toBe("Channel");
    expect(formatDay(Date.UTC(2020, 0, 2))).toBe("2020-01-02");
    expect(formatDay(null)).toBe("-");
    expect(watchUrl(ID)).toBe(`https://www.youtube.com/watch?v=${ID}`);
  });
});

describe("history helpers", () => {
  it("formats values per field", () => {
    expect(formatChangeValue("title", null)).toBe("(none)");
    expect(formatChangeValue("title", "")).toBe("(none)");
    expect(formatChangeValue("views", 1234567)).toBe("1,234,567");
    expect(formatChangeValue("duration_s", 3723)).toBe("1:02:03");
    expect(formatChangeValue("upload_date", Date.UTC(2021, 4, 6))).toBe("2021-05-06");
    expect(formatChangeValue("caption_available", true)).toBe("yes");
    expect(formatChangeValue("caption_available", false)).toBe("no");
    expect(formatChangeValue("tags_json", ["a", "b"])).toBe("a, b");
    expect(formatChangeValue("tags_json", [])).toBe("(none)");
    expect(formatChangeValue("formats", { h: 1 })).toBe('{"h":1}');
    expect(fieldLabel("tags_json")).toBe("Tags");
    expect(fieldLabel("some_field")).toBe("some field");
  });

  it("splits counters from real changes", () => {
    const rows = [
      change({ id: 1, field: "views" }),
      change({ id: 2, field: "title" }),
      change({ id: 3, field: "likes" }),
    ];
    const view = splitHistory(rows);
    expect(view.changes.map((row) => row.id)).toEqual([2]);
    expect(view.counters.map((row) => row.id)).toEqual([1, 3]);
    expect(isCounterField("ryd_dislikes")).toBe(true);
    expect(isCounterField("description")).toBe(false);
  });

  it("builds chart data in time order on two axes", () => {
    const data = statsChartData([
      point(Date.UTC(2024, 0, 3), 30, 3, 1),
      point(Date.UTC(2024, 0, 1), 10, 1, 0),
      point(Date.UTC(2024, 0, 2), null, 2, 0),
    ]);
    expect(data.labels).toEqual(["2024-01-01", "2024-01-02", "2024-01-03"]);
    expect(data.datasets.map((set) => [set.label, set.yAxisID])).toEqual([
      ["Views", "y"],
      ["Likes", "y1"],
      ["Comments", "y1"],
    ]);
    expect(data.datasets[0]!.data).toEqual([10, null, 30]);
    expect(data.datasets[0]!.pointRadius).toBe(2);
    const many = statsChartData(Array.from({ length: 61 }, (_, i) => point(i * 1000, i)));
    expect(many.datasets[0]!.pointRadius).toBe(0);
    const options = statsChartOptions("#fff", "#333") as {
      scales: { y1: { position: string } };
    };
    expect(options.scales.y1.position).toBe("right");
  });
});

describe("runBulkJobs", () => {
  it("queues every id through a pool and counts deduped jobs", async () => {
    let active = 0;
    let peak = 0;
    const enqueue = vi.fn(async (id: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { job_id: 1, deduped: id.endsWith("1") };
    });
    const ids = Array.from({ length: 10 }, (_, i) => idFor(i));
    const outcome = await runBulkJobs(ids, enqueue, 3);
    expect(outcome).toEqual({
      queued: 10,
      deduped: 1,
      failed: 0,
      unavailable: false,
      firstError: null,
    });
    expect(peak).toBe(3);
  });

  it("stops at the first 501 and records other failures", async () => {
    const unavailable = vi.fn(async () => {
      throw new ApiClientError("not_implemented", "no", 501);
    });
    const stopped = await runBulkJobs(
      Array.from({ length: 20 }, (_, i) => idFor(i)),
      unavailable,
      2,
    );
    expect(stopped.unavailable).toBe(true);
    expect(unavailable.mock.calls.length).toBeLessThanOrEqual(2);

    const flaky = vi.fn(async (id: string) => {
      if (id === idFor(1)) throw new ApiClientError("http_500", "boom", 500);
      return { job_id: 2, deduped: false };
    });
    const mixed = await runBulkJobs([idFor(0), idFor(1), idFor(2)], flaky);
    expect(mixed).toMatchObject({ queued: 2, failed: 1, firstError: "boom" });
    expect(await runBulkJobs([], flaky)).toMatchObject({ queued: 0 });
  });
});
