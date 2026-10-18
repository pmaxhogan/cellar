import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import SelfCheckPage from "../../src/pages/SelfCheckPage.vue";
import {
  checkPrefix,
  groupResults,
  listChecks,
  worstLevel,
  type CheckResult,
  type CheckRow,
} from "../../src/api/checks.ts";
import { flush } from "../helpers/dom.ts";
import { apiError, fakeServer, json, type FakeServer } from "../helpers/fakeServer.ts";
import { mountGlobals } from "../helpers/mount.ts";

const NOW = Date.now();

function result(key: string, level: CheckResult["level"], detail = ""): CheckResult {
  return { key, label: key, level, detail, took_ms: 12 };
}

function makeRun(overrides: Partial<CheckRow> = {}): CheckRow {
  return {
    id: 1,
    run_at: NOW - 3_600_000,
    trigger: "boot",
    ok: false,
    results: [
      result("data.writable", "ok", "/data is writable"),
      result("data.free", "warn", "9% free"),
      result("db.integrity", "ok"),
      result("tools.ytdlp", "ok", "2026.10.10"),
      result("gpu.nvenc", "skip", "No GPU passed through"),
      result("pot.reachable", "fail", "connect ECONNREFUSED"),
      result("youtube.favicon", "ok"),
      result("account.1.token", "ok"),
      result("push.vapid", "ok"),
      result("clock.skew", "ok", "120 ms"),
      result("proxy.pool", "skip"),
      result("mystery.check", "ok"),
    ],
    ...overrides,
  };
}

let pinia: Pinia;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

async function mountPage(fake: FakeServer) {
  const wrapper = mount(SelfCheckPage, { global: mountGlobals({ api: fake.api, pinia }) });
  await flush();
  return wrapper;
}

function server(latest: CheckRow | null, history: CheckRow[] = latest === null ? [] : [latest]) {
  return fakeServer()
    .on("GET", "/api/checks/latest", () =>
      latest === null ? apiError(404, "No self-check has run yet.", "not_found") : json(latest),
    )
    .on("GET", "/api/checks", () => json({ rows: history }));
}

describe("grouping", () => {
  it("groups by key prefix in a fixed order, with unknown prefixes last", () => {
    const groups = groupResults(makeRun().results);
    expect(groups.map((group) => group.key)).toEqual([
      "data",
      "db",
      "tools",
      "gpu",
      "pot",
      "youtube",
      "account",
      "push",
      "clock",
      "proxy",
      "other",
    ]);
    expect(groups[0]!.results.map((r) => r.key)).toEqual(["data.writable", "data.free"]);
    expect(groups[0]!.level).toBe("warn");
    expect(groups.find((group) => group.key === "pot")!.level).toBe("fail");
    expect(groups.find((group) => group.key === "gpu")!.level).toBe("skip");
  });

  it("reads prefixes with either separator and ranks levels", () => {
    expect(checkPrefix("tools.ffmpeg")).toBe("tools");
    expect(checkPrefix("account:2")).toBe("account");
    expect(checkPrefix("DB")).toBe("db");
    expect(worstLevel([])).toBe("skip");
    expect(worstLevel([result("a", "ok"), result("b", "fail"), result("c", "warn")])).toBe("fail");
  });

  it("asks the history endpoint for a limit", async () => {
    const fake = fakeServer().on("GET", "/api/checks", () => json({ rows: [] }));
    await listChecks(fake.api, 5);
    expect(fake.calls[0]!.query.get("limit")).toBe("5");
  });
});

describe("Self-check page", () => {
  it("renders the latest run as a grid of coloured groups", async () => {
    const wrapper = await mountPage(server(makeRun()));
    const groups = wrapper.findAll("[data-group]");
    expect(groups).toHaveLength(11);
    expect(wrapper.find("[data-group='data']").attributes("data-level")).toBe("warn");
    expect(wrapper.find("[data-group='data']").classes()).toContain("level-warn");
    expect(wrapper.find("[data-group='pot']").classes()).toContain("level-fail");
    expect(wrapper.find("[data-group='youtube']").classes()).toContain("level-ok");
    expect(wrapper.find("[data-group='gpu']").classes()).toContain("level-skip");
    const pot = wrapper.find("[data-check='pot.reachable']");
    expect(pot.text()).toContain("connect ECONNREFUSED");
    expect(pot.text()).toContain("12 ms");
    expect(wrapper.find("[data-group='other']").text()).toContain("Other");
    expect(wrapper.find("[data-summary]").text()).toContain("1 check failing");
    expect(wrapper.find("[data-summary]").text()).toContain("1 warning");
    expect(wrapper.find("[data-summary]").text()).toContain("1 h ago (boot)");
  });

  it("shows an empty state when no run exists yet", async () => {
    const wrapper = await mountPage(server(null));
    expect(wrapper.find(".empty-state h2").text()).toBe("No checks have run");
    expect(wrapper.find(".empty-state [data-icon='selfcheck']").exists()).toBe(true);
    expect(wrapper.find(".error-state").exists()).toBe(false);
  });

  it("runs the self-check, shows a spinner, and replaces the grid", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fresh = makeRun({
      id: 2,
      run_at: NOW,
      trigger: "manual",
      ok: true,
      results: [result("tools.ytdlp", "ok"), result("db.integrity", "ok")],
    });
    const fake = server(makeRun()).on("POST", "/api/checks/run", async () => {
      await gate;
      return json(fresh);
    });
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-action='run']").trigger("click");
    await flush();
    expect(wrapper.find("[data-running]").exists()).toBe(true);
    expect(wrapper.find("[data-action='run']").attributes("disabled")).toBeDefined();
    expect(wrapper.findAll("[data-group]")).toHaveLength(0);

    release();
    await flush();
    expect(wrapper.find("[data-running]").exists()).toBe(false);
    expect(wrapper.findAll("[data-group]").map((g) => g.attributes("data-group"))).toEqual([
      "db",
      "tools",
    ]);
    expect(wrapper.find("[data-summary]").text()).toContain("all checks ok");
    expect(wrapper.findAll("[data-run]")).toHaveLength(2);
    expect(wrapper.findAll("[data-run]")[0]!.attributes("data-run")).toBe("2");
  });

  it("keeps the grid when a run fails", async () => {
    const fake = server(makeRun()).on("POST", "/api/checks/run", () => apiError(500, "boom"));
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-action='run']").trigger("click");
    await flush();
    expect(wrapper.findAll("[data-group]")).toHaveLength(11);
  });

  it("lists past runs with their failing count and opens one on click", async () => {
    const latest = makeRun({ id: 3, ok: true, results: [result("db.integrity", "ok")] });
    const past = makeRun({ id: 2, trigger: "schedule", run_at: NOW - 86_400_000 });
    const wrapper = await mountPage(server(latest, [latest, past]));

    const rows = wrapper.findAll("[data-run]");
    expect(rows).toHaveLength(2);
    expect(wrapper.findAll("[data-failing]").map((cell) => cell.text())).toEqual(["0", "1"]);
    expect(wrapper.find(".check-history").text()).toContain("schedule");

    await rows[1]!.trigger("click");
    await flush();
    expect(wrapper.find("[data-viewing-past]").exists()).toBe(true);
    expect(wrapper.findAll("[data-group]")).toHaveLength(11);
    expect(wrapper.find("[data-summary]").text()).toContain("(schedule)");

    await wrapper.find("[data-action='latest']").trigger("click");
    expect(wrapper.find("[data-viewing-past]").exists()).toBe(false);
    expect(wrapper.findAll("[data-group]")).toHaveLength(1);

    // Clicking the latest run in the history is the same as going back.
    await wrapper.findAll("[data-run]")[1]!.trigger("click");
    expect(wrapper.find("[data-viewing-past]").exists()).toBe(true);
    await wrapper.findAll("[data-run]")[0]!.trigger("click");
    expect(wrapper.find("[data-viewing-past]").exists()).toBe(false);
  });

  it("shows an error state for the latest run, and a note for the history", async () => {
    let fail = true;
    const fake = fakeServer()
      .on("GET", "/api/checks/latest", () => (fail ? apiError(500, "down") : json(makeRun())))
      .on("GET", "/api/checks", () =>
        fail ? apiError(500, "History is down.") : json({ rows: [] }),
      );
    const wrapper = await mountPage(fake);
    expect(wrapper.find(".error-state").exists()).toBe(true);
    expect(wrapper.text()).toContain("History is down.");
    fail = false;
    await wrapper.find(".error-state button").trigger("click");
    await flush();
    expect(wrapper.findAll("[data-group]")).toHaveLength(11);
  });

  it("labels a run that is not ok but has no failing check", async () => {
    const run = makeRun({ ok: false, results: [result("db.integrity", "warn")] });
    const wrapper = await mountPage(server(run));
    expect(wrapper.find("[data-summary]").text()).toContain("problems found");
  });

  it("uses ASCII only in its copy", async () => {
    const wrapper = await mountPage(server(makeRun()));
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(wrapper.text())).toBe(true);
  });
});
