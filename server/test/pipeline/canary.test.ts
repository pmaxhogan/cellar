import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANARY_KV_KEY,
  canaryBudgetOk,
  FAVICON_URL,
  maybeEnqueueCanary,
  recentCanaryRuns,
  runCanary,
} from "../../src/domain/canary.ts";
import { setKv } from "../../src/db/kv.ts";
import { runCanaryJob } from "../../src/jobs/handlers/canary.ts";
import { activityKinds, createHarness, makeCtx, type Harness } from "./harness.ts";

let h: Harness;
let fetched: string[];

function favicon(ok: boolean | "throw"): void {
  h.deps.fetch = (url) => {
    fetched.push(url);
    if (ok === "throw") {
      return Promise.reject(new Error("getaddrinfo ENOTFOUND"));
    }
    return Promise.resolve(new Response("icon", { status: ok ? 200 : 503 }));
  };
}

beforeEach(() => {
  h = createHarness();
  fetched = [];
});

afterEach(() => {
  h.close();
});

describe("canary", () => {
  it("downloads the known-good video without cookies and discards it", async () => {
    favicon(true);
    const record = join(h.root, "ytdlp.argv");
    h.env.FAKE_YTDLP_RECORD = record;
    const outcome = await runCanary(h.deps);
    expect(outcome).toMatchObject({ canaryOk: true, faviconOk: true, verdict: "ok" });
    const argv = JSON.parse(readFileSync(record, "utf8").trim()) as string[];
    expect(argv).toContain("worst");
    expect(argv).not.toContain("--cookies");
    expect(argv.at(-1)).toContain("dQw4w9WgXcQ");
    expect(argv).toContain("--plugin-dirs");
    expect(fetched).toEqual([FAVICON_URL]);
    expect(readdirSync(h.tmpDir).filter((name) => name.startsWith("canary-"))).toEqual([]);
    expect(activityKinds(h.db)).toEqual(["canary.ok"]);
    expect(recentCanaryRuns(h.deps)).toEqual([h.clock.now]);
  });

  it("notifies youtube_broken when the canary fails but YouTube answers", async () => {
    favicon(true);
    h.env.FAKE_YTDLP_FAIL = "1";
    const outcome = await runCanary(h.deps);
    expect(outcome.verdict).toBe("youtube_broken");
    expect(outcome.detail).toContain("not a bot");
    const note = h.db.get<{ body: string }>(
      "SELECT body FROM notifications WHERE type = 'youtube_broken'",
    );
    expect(note?.body).toContain("canary");
    expect(activityKinds(h.db)).toEqual(["canary.failed"]);
  });

  it("reports a network outage when both fail, without notifying", async () => {
    favicon("throw");
    h.env.FAKE_YTDLP_FAIL = "1";
    expect((await runCanary(h.deps)).verdict).toBe("network_outage");
    favicon(false);
    expect((await runCanary(h.deps)).verdict).toBe("network_outage");
    expect(h.db.get("SELECT id FROM notifications")).toBeUndefined();
    expect(activityKinds(h.db)).toEqual(["canary.network", "canary.network"]);
  });

  it("treats a tool that cannot start as a failed canary", async () => {
    favicon(true);
    h.env.CELLAR_TOOL_YT_DLP = JSON.stringify([join(h.root, "missing-binary")]);
    const outcome = await runCanary(h.deps);
    expect(outcome.canaryOk).toBe(false);
    expect(outcome.verdict).toBe("youtube_broken");
  });

  it("runs at most canary.max_per_hour times per hour", async () => {
    favicon(true);
    expect(canaryBudgetOk(h.deps)).toBe(true);
    expect(maybeEnqueueCanary(h.deps, "test")).toBe(true);
    expect(maybeEnqueueCanary(h.deps, "test")).toBe(false);
    const test = makeCtx(h, { type: "canary" });
    await runCanaryJob(h.deps, test.ctx);
    expect(canaryBudgetOk(h.deps)).toBe(false);
    h.db.run("DELETE FROM jobs WHERE type = 'canary'");
    expect(maybeEnqueueCanary(h.deps, "test")).toBe(false);

    const again = makeCtx(h, { type: "canary" });
    await runCanaryJob(h.deps, again.ctx);
    expect(activityKinds(h.db)).toEqual(["canary.ok"]);

    h.clock.now += 60 * 60_000;
    expect(canaryBudgetOk(h.deps)).toBe(true);
  });

  it("ignores junk in the stored run list", () => {
    setKv(h.db, CANARY_KV_KEY, { runs: ["x", h.clock.now + 5, h.clock.now - 1000] });
    expect(recentCanaryRuns(h.deps)).toEqual([h.clock.now - 1000]);
    setKv(h.db, CANARY_KV_KEY, "broken");
    expect(recentCanaryRuns(h.deps)).toEqual([]);
  });
});
