import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import AboutPage from "../../src/pages/AboutPage.vue";
import {
  summarizeOutcomes,
  type ToolsResponse,
  type ToolUpdateOutcome,
  type ToolVersions,
} from "../../src/api/tools.ts";
import { captureToasts, type CapturedToast } from "../helpers/adminFetch.ts";
import { flush } from "../helpers/dom.ts";
import { apiError, fakeServer, json, type FakeServer } from "../helpers/fakeServer.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { makeStatus } from "../helpers/stubApi.ts";

const NOW = Date.now();

/** update_available follows the server's rule for yt-dlp unless a test says otherwise. */
function versions(overrides: Partial<ToolVersions> = {}): ToolVersions {
  const base = {
    current: "2026.10.10",
    previous: "2026.09.30",
    baseline: "2026.09.01",
    latest: "2026.10.10",
    checked_at: NOW - 2 * 3_600_000,
    updated_at: NOW - 86_400_000,
    last_error: null,
    rolled_back_from: null,
    ...overrides,
  };
  return {
    ...base,
    update_available:
      overrides.update_available ??
      (base.latest !== null && base.current !== null && base.latest !== base.current),
  };
}

function makeTools(overrides: Partial<ToolsResponse> = {}): ToolsResponse {
  return {
    ytdlp: versions(),
    ffmpeg: versions({ current: "7.1", previous: null, baseline: "7.1", latest: "7.1.1" }),
    js_runtime: "node 26.1.0",
    pot_provider_url: "http://bgutil:4416",
    auto_update: true,
    ffmpeg_release_tag: "autobuild-2025-12-31-14-28",
    ...overrides,
  };
}

let pinia: Pinia;
let toasts: CapturedToast[];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  toasts = captureToasts();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function server(tools: ToolsResponse = makeTools()) {
  return fakeServer()
    .on("GET", "/api/status", () => json(makeStatus()))
    .on("GET", "/api/tools", () => json(tools));
}

async function mountPage(fake: FakeServer) {
  const wrapper = mount(AboutPage, { global: mountGlobals({ api: fake.api, pinia }) });
  await flush();
  return wrapper;
}

function row(wrapper: VueWrapper, tool: string) {
  return wrapper.find(`[data-tool-row='${tool}']`);
}

function cell(wrapper: VueWrapper, tool: string, version: string) {
  return row(wrapper, tool).find(`[data-version='${version}']`);
}

describe("About tools", () => {
  it("shows current, previous, baseline, latest and when it was checked", async () => {
    const wrapper = await mountPage(server());
    expect(cell(wrapper, "ytdlp", "current").text()).toBe("2026.10.10");
    expect(cell(wrapper, "ytdlp", "previous").text()).toBe("2026.09.30");
    expect(cell(wrapper, "ytdlp", "baseline").text()).toBe("2026.09.01");
    expect(cell(wrapper, "ytdlp", "latest").text()).toBe("2026.10.10");
    expect(cell(wrapper, "ytdlp", "checked").text()).toBe("2 h ago");
    expect(cell(wrapper, "ffmpeg", "previous").text()).toBe("-");
    expect(cell(wrapper, "ffmpeg", "latest").text()).toContain("update available");
    expect(cell(wrapper, "ytdlp", "latest").text()).not.toContain("update available");
    expect(wrapper.find("[data-fact='js-runtime']").text()).toBe("node 26.1.0");
    expect(wrapper.find("[data-fact='pot-provider']").text()).toBe("http://bgutil:4416");
    // The status-only fallback card is replaced by the detailed one.
    expect(wrapper.find("[data-tool='yt-dlp']").exists()).toBe(false);
  });

  it("disables roll back without a previous build", async () => {
    const wrapper = await mountPage(server());
    const ffmpegRollback = row(wrapper, "ffmpeg").find("[data-tool-action='rollback']");
    const ytdlpRollback = row(wrapper, "ytdlp").find("[data-tool-action='rollback']");
    expect(ffmpegRollback.attributes("disabled")).toBeDefined();
    expect(ytdlpRollback.attributes("disabled")).toBeUndefined();
  });

  it("checks for updates across every tool", async () => {
    const fake = server().on("POST", "/api/tools/update", () =>
      json(makeTools({ ytdlp: versions({ latest: "2026.10.17" }) })),
    );
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-tool-action='check']").trigger("click");
    await flush();
    const calls = fake.callsTo("POST", "/api/tools/update");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({});
    expect(cell(wrapper, "ytdlp", "latest").text()).toContain("2026.10.17");
    expect(cell(wrapper, "ytdlp", "latest").text()).toContain("update available");
  });

  it("says when everything is up to date", async () => {
    const current = makeTools({ ffmpeg: versions({ current: "7.1", latest: "7.1" }) });
    const fake = server().on("POST", "/api/tools/update", () => json(current));
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-tool-action='check']").trigger("click");
    await flush();
    expect(cell(wrapper, "ffmpeg", "latest").text()).toBe("7.1");
  });

  it("updates one tool now", async () => {
    const fake = server().on("POST", "/api/tools/update", () =>
      json(
        makeTools({
          ffmpeg: versions({ current: "7.1.1", previous: "7.1", baseline: "7.1", latest: "7.1.1" }),
        }),
      ),
    );
    const wrapper = await mountPage(fake);
    await row(wrapper, "ffmpeg").find("[data-tool-action='update']").trigger("click");
    await flush();
    expect(fake.callsTo("POST", "/api/tools/update")[0]!.body).toEqual({
      tool: "ffmpeg",
      force: true,
    });
    expect(cell(wrapper, "ffmpeg", "current").text()).toBe("7.1.1");
    expect(cell(wrapper, "ffmpeg", "previous").text()).toBe("7.1");
    expect(
      row(wrapper, "ffmpeg").find("[data-tool-action='rollback']").attributes("disabled"),
    ).toBe(undefined);
  });

  it("rolls back after confirming, and can be cancelled", async () => {
    const fake = server().on("POST", "/api/tools/rollback", () =>
      json(makeTools({ ytdlp: versions({ current: "2026.09.30", previous: null }) })),
    );
    const wrapper = await mountPage(fake);
    await row(wrapper, "ytdlp").find("[data-tool-action='rollback']").trigger("click");
    await flush();
    expect(wrapper.text()).toContain("from 2026.10.10 back to 2026.09.30");

    const cancel = wrapper.findAll("button").find((button) => button.text() === "Cancel")!;
    await cancel.trigger("click");
    await flush();
    expect(wrapper.text()).not.toContain("Roll back this tool?");
    expect(fake.callsTo("POST", "/api/tools/rollback")).toHaveLength(0);

    await row(wrapper, "ytdlp").find("[data-tool-action='rollback']").trigger("click");
    await flush();
    const confirm = wrapper
      .findAll("button")
      .filter((button) => button.text() === "Roll back")
      .at(-1)!;
    await confirm.trigger("click");
    await flush();
    const calls = fake.callsTo("POST", "/api/tools/rollback");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ tool: "ytdlp" });
    expect(cell(wrapper, "ytdlp", "current").text()).toBe("2026.09.30");
    expect(wrapper.text()).not.toContain("Roll back this tool?");
  });

  it("keeps the versions when an action fails", async () => {
    const fake = server()
      .on("POST", "/api/tools/update", () => apiError(502, "GitHub is unreachable."))
      .on("POST", "/api/tools/rollback", () => apiError(409, "Nothing to roll back."));
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-tool-action='check']").trigger("click");
    await flush();
    await row(wrapper, "ytdlp").find("[data-tool-action='update']").trigger("click");
    await flush();
    await row(wrapper, "ytdlp").find("[data-tool-action='rollback']").trigger("click");
    await flush();
    const confirm = wrapper
      .findAll("button")
      .filter((button) => button.text() === "Roll back")
      .at(-1)!;
    await confirm.trigger("click");
    await flush();
    expect(cell(wrapper, "ytdlp", "current").text()).toBe("2026.10.10");
    // The dialog stays open so the owner can try again or cancel.
    expect(wrapper.text()).toContain("Roll back this tool?");
  });

  it("falls back to the status versions when the tools endpoint fails", async () => {
    const fake = server().on("GET", "/api/tools", () => apiError(404, "Not found."));
    const wrapper = await mountPage(fake);
    expect(wrapper.find("[data-tool='yt-dlp']").text()).toBe("2026.10.10");
    expect(wrapper.find("[data-tools-error]").text()).toContain("Not found.");
  });

  it("marks a missing tool and missing runtime facts", async () => {
    const fake = server(
      makeTools({
        ytdlp: versions({ current: null, latest: null, checked_at: null }),
        js_runtime: null,
        // The server sends an empty string when the provider is disabled.
        pot_provider_url: "",
      }),
    );
    const wrapper = await mountPage(fake);
    expect(cell(wrapper, "ytdlp", "current").text()).toBe("not found");
    expect(cell(wrapper, "ytdlp", "checked").text()).toBe("never");
    expect(wrapper.find("[data-fact='js-runtime']").text()).toBe("none detected");
    expect(wrapper.find("[data-fact='pot-provider']").text()).toBe("not set");
  });

  it("links the repository, the docs and the owner steps", async () => {
    const wrapper = await mountPage(server());
    const hrefs = wrapper.findAll(".about-links a").map((link) => link.attributes("href"));
    expect(hrefs).toContain("https://github.com/pmaxhogan/cellar");
    expect(hrefs).toContain("https://github.com/pmaxhogan/cellar/blob/main/docs/ARCHITECTURE.md");
    expect(hrefs).toContain(
      "https://github.com/pmaxhogan/cellar/blob/main/docs/setup-cloudflare.md",
    );
    expect(wrapper.text()).toContain("Trello card");
  });

  it("refreshes the tools with the status", async () => {
    const fake = server();
    const wrapper = await mountPage(fake);
    const refresh = wrapper.findAll("button").find((button) => button.text() === "Refresh")!;
    await refresh.trigger("click");
    await flush();
    expect(fake.callsTo("GET", "/api/tools")).toHaveLength(2);
    expect(fake.callsTo("GET", "/api/status")).toHaveLength(2);
  });

  it("uses ASCII only in its copy", async () => {
    const wrapper = await mountPage(server());
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(wrapper.text())).toBe(true);
  });
});

describe("About tools: update outcomes", () => {
  const failedFfmpeg: ToolUpdateOutcome = {
    tool: "ffmpeg",
    status: "failed",
    detail: "fetch failed: getaddrinfo ENOTFOUND api.github.com",
  };
  const upToDateYtdlp: ToolUpdateOutcome = {
    tool: "ytdlp",
    status: "up_to_date",
    detail: "yt-dlp is up to date (2026.10.10).",
  };

  it("shows a failed check per tool and toasts an error, not 'up to date'", async () => {
    const after = makeTools({
      ffmpeg: versions({
        current: "7.1",
        latest: "7.1",
        last_error: failedFfmpeg.detail,
      }),
      outcomes: [upToDateYtdlp, failedFfmpeg],
    });
    const fake = server().on("POST", "/api/tools/update", () => json(after));
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-tool-action='check']").trigger("click");
    await flush();

    const ffmpeg = wrapper.find("[data-tool-outcome='ffmpeg']");
    expect(ffmpeg.attributes("data-status")).toBe("failed");
    expect(ffmpeg.text()).toContain("failed");
    expect(ffmpeg.text()).toContain("getaddrinfo ENOTFOUND api.github.com");
    const ytdlp = wrapper.find("[data-tool-outcome='ytdlp']");
    expect(ytdlp.attributes("data-status")).toBe("up_to_date");
    expect(ytdlp.text()).toContain("up to date");

    // The stored error sits on the card too.
    expect(wrapper.find("[data-tool-error='ffmpeg']").text()).toContain(
      "getaddrinfo ENOTFOUND api.github.com",
    );
    expect(wrapper.find("[data-tool-error='ytdlp']").exists()).toBe(false);

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      severity: "error",
      summary: "Update check failed for ffmpeg",
      detail: "yt-dlp: up to date; ffmpeg: failed",
    });
    expect(toasts.some((toast) => toast.summary === "Tools are up to date")).toBe(false);
  });

  it("shows the stored last error before any check runs", async () => {
    const wrapper = await mountPage(
      server(
        makeTools({
          ffmpeg: versions({
            current: "7.1",
            latest: "7.1",
            last_error: "staged ffmpeg cannot use NVENC on this driver; kept the current build",
          }),
        }),
      ),
    );
    expect(wrapper.find("[data-tool-error='ffmpeg']").text()).toContain(
      "ffmpeg, last update check: staged ffmpeg cannot use NVENC on this driver",
    );
    expect(wrapper.find("[data-tool-outcomes]").exists()).toBe(false);
    expect(wrapper.find("[data-fact='ffmpeg-release']").text()).toBe("autobuild-2025-12-31-14-28");
  });

  it("warns for a blocked forced update instead of claiming it updated", async () => {
    const blocked: ToolUpdateOutcome = {
      tool: "ffmpeg",
      status: "blocked",
      detail: "staged ffmpeg cannot use NVENC on this driver; kept the current build (build x).",
    };
    const fake = server().on("POST", "/api/tools/update", () =>
      json(makeTools({ outcomes: [blocked] })),
    );
    const wrapper = await mountPage(fake);
    await row(wrapper, "ffmpeg").find("[data-tool-action='update']").trigger("click");
    await flush();
    expect(wrapper.find("[data-tool-outcome='ffmpeg']").attributes("data-status")).toBe("blocked");
    expect(toasts).toEqual([
      expect.objectContaining({
        severity: "warn",
        summary: "Update blocked for ffmpeg",
        detail: "ffmpeg: blocked",
      }),
    ]);
  });

  it("toasts success only when every tool is up to date or updated", async () => {
    const fake = server().on("POST", "/api/tools/update", () =>
      json(
        makeTools({
          outcomes: [upToDateYtdlp, { tool: "ffmpeg", status: "up_to_date", detail: "ok" }],
        }),
      ),
    );
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-tool-action='check']").trigger("click");
    await flush();
    expect(toasts).toEqual([
      expect.objectContaining({ severity: "success", summary: "Tools are up to date" }),
    ]);
  });

  it("follows the worst outcome", () => {
    const outcome = (tool: "ytdlp" | "ffmpeg", status: ToolUpdateOutcome["status"]) => ({
      tool,
      status,
      detail: "",
    });
    expect(summarizeOutcomes([outcome("ytdlp", "updated"), outcome("ffmpeg", "updated")])).toEqual({
      severity: "success",
      summary: "Tools updated",
      detail: "yt-dlp, ffmpeg",
    });
    expect(
      summarizeOutcomes([outcome("ytdlp", "available"), outcome("ffmpeg", "updated")]),
    ).toEqual({ severity: "info", summary: "Updates available", detail: "yt-dlp" });
    expect(
      summarizeOutcomes([outcome("ytdlp", "failed"), outcome("ffmpeg", "blocked")]).severity,
    ).toBe("error");
    expect(
      summarizeOutcomes([outcome("ytdlp", "skipped"), outcome("ffmpeg", "blocked")]).summary,
    ).toBe("Update blocked for ffmpeg");
    expect(summarizeOutcomes([outcome("ytdlp", "skipped")])).toEqual({
      severity: "info",
      summary: "Nothing installed",
      detail: "yt-dlp: skipped",
    });
    expect(summarizeOutcomes([outcome("ytdlp", "up_to_date")])).toMatchObject({
      severity: "success",
      summary: "Tools are up to date",
    });
    expect(
      summarizeOutcomes([outcome("ytdlp", "failed"), outcome("ffmpeg", "failed")]).summary,
    ).toBe("Update check failed for yt-dlp, ffmpeg");
  });
});
