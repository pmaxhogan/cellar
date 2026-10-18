import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import Select from "primevue/select";
import type { VideoDetail } from "@cellar/shared";
import VideoPage from "../../src/pages/VideoPage.vue";
import { routes } from "../../src/router/index.ts";
import { flush } from "../helpers/dom.ts";
import { captureToasts, type CapturedToast } from "../helpers/adminFetch.ts";
import { apiError, fakeServer, json, type FakeServer } from "../helpers/fakeServer.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { makeInspect } from "../rules/fakeApi.ts";
import {
  account,
  change,
  ID,
  listPage,
  location,
  mediaRow,
  point,
  shareRow,
  videoDetail,
} from "./fixtures.ts";

let toasts: CapturedToast[];

beforeEach(() => {
  toasts = captureToasts();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const BASE = `/api/videos/${ID}`;

function serve(detail: Partial<VideoDetail> = {}): FakeServer {
  return fakeServer()
    .on("GET", BASE, () => json(videoDetail(detail)))
    .on("GET", `${BASE}/history`, () => json(listPage([change()], 1)))
    .on("GET", `${BASE}/stats`, () =>
      json({ points: [point(Date.UTC(2024, 0, 1), 10), point(Date.UTC(2024, 0, 2), 20)] }),
    )
    .on("GET", "/api/shares", () => json(listPage([shareRow()], 1, 1, 100)))
    .on("GET", "/api/inspect", () => json(makeInspect()))
    .on("GET", "/api/accounts", () => json({ rows: [account()] }))
    .on("GET", "/api/locations", () => json({ rows: [location()] }))
    .on("GET", "/api/proxies", () => json({ rows: [] }));
}

async function mountVideo(server: FakeServer, id = ID): Promise<VueWrapper> {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(`/videos/${id}`);
  await router.isReady();
  const globals = mountGlobals({ api: server.api, router });
  const wrapper = mount(VideoPage, {
    global: { ...globals, stubs: { ...globals.stubs, Chart: true } },
  });
  await flush(5);
  return wrapper;
}

function find(wrapper: VueWrapper, selector: string) {
  const found = wrapper.find(selector);
  if (!found.exists()) throw new Error(`missing ${selector}`);
  return found;
}

function dialogButton(wrapper: VueWrapper, label: string) {
  const found = wrapper
    .findAll(".p-dialog button")
    .find((candidate) => candidate.text().trim() === label);
  if (found === undefined) throw new Error(`no dialog button labelled ${label}`);
  return found;
}

describe("VideoPage sections", () => {
  it("renders the header, facts, downloads, metadata, sources and files", async () => {
    const wrapper = await mountVideo(serve());
    expect(wrapper.find("h1").text()).toBe("A video about things");
    const facts = find(wrapper, "[data-test='video-facts']");
    expect(find(wrapper, "[data-test='video-channel'] a").attributes("href")).toBe(
      "/?channel_id=UC0123456789abcdefghijkl",
    );
    expect(facts.text()).toContain("Uploaded 2024-03-05");
    expect(facts.text()).toContain("4:05");
    expect(find(wrapper, "[data-test='status']").text()).toBe("public");
    const priority = find(wrapper, "[data-test='video-priority']");
    expect(priority.text()).toContain("Priority 5");
    expect(priority.find("a").attributes("href")).toBe("/rules?edit=7");

    const downloads = find(wrapper, "[data-test='downloads']");
    expect(downloads.find("[data-download='video']").attributes("href")).toBe(
      `${BASE}/media/11?download=1`,
    );
    expect(downloads.find("[data-download='video']").text()).toContain("1080p, av01.0.08M.08");
    expect(downloads.find("[data-download='audio']").attributes("href")).toBe(
      `${BASE}/media/12?download=1`,
    );
    expect(downloads.find("[data-download='captions-en']").attributes("href")).toBe(
      `${BASE}/media/13?download=1`,
    );
    expect(downloads.find("[data-download='captions-de']").exists()).toBe(true);
    const meta = downloads.find("[data-download='metadata']");
    expect(meta.attributes("href")).toBe(`${BASE}/metadata.json`);
    expect(meta.attributes("download")).toBe(`${ID}.metadata.json`);
    expect(wrapper.find("[data-test='no-media']").exists()).toBe(false);

    const metadata = find(wrapper, "[data-test='metadata']");
    expect(metadata.find("[data-test='description']").text()).toContain("Line one");
    expect(metadata.find("[data-test='tags']").text()).toContain("science");
    expect(metadata.find("[data-test='views']").text()).toBe("12,345");
    expect(metadata.find("[data-test='formats']").text()).toBe("up to 2160p60; AV1, VP9");
    expect(metadata.find("[data-test='recheck-tier']").text()).toBe("weekly");
    expect(metadata.find("[data-test='last-recheck']").text()).toContain("1 h ago");
    expect(metadata.find("[data-test='next-recheck']").text()).toContain("in 24 h");
    expect(metadata.text()).toContain("97.5% likes");

    expect(find(wrapper, "[data-test='sources']").text()).toContain("Liked (main)");
    const media = find(wrapper, "[data-test='media-table']");
    expect(media.findAll("tbody tr")).toHaveLength(5);
    expect(media.findAll("[data-test='current']")).toHaveLength(4);
    expect(media.find("[data-media='11']").text()).toContain("Fast disk");
    expect(media.find("[data-media='11']").text()).toContain("1080p30");
    expect(media.find("[data-media='13']").text()).toContain("captions (en)");
    expect(media.find("[data-media='13']").text()).toContain("metadata");

    expect(find(wrapper, "[data-test='inspect-panel']").exists()).toBe(true);
  });

  it("expands the description", async () => {
    const wrapper = await mountVideo(serve());
    const text = find(wrapper, "[data-test='description']");
    expect(text.classes()).toContain("video-description__text--clamped");
    await find(wrapper, "[data-test='description-toggle']").trigger("click");
    expect(text.classes()).not.toContain("video-description__text--clamped");
  });

  it("explains where the priority came from", async () => {
    const override = await mountVideo(serve({ overrides: { reclaim_priority: -1 } }));
    expect(find(override, "[data-test='video-priority']").text()).toContain(
      "set by this video's override",
    );
    const none = await mountVideo(serve({ effective: null, reclaim_priority: null }));
    expect(find(none, "[data-test='video-priority']").text()).toContain("not evaluated yet");
    const defaults = await mountVideo(
      serve({
        effective: {
          values: {},
          provenance: { reclaim_priority: "default" },
          matched_rule_ids: [],
          evaluated_at: 1,
          next_eval_at: null,
        },
      }),
    );
    expect(find(defaults, "[data-test='video-priority']").text()).toContain("from the defaults");
  });

  it("copes with a sparse video", async () => {
    const wrapper = await mountVideo(
      serve({
        title: null,
        description: null,
        tags: [],
        channel_id: null,
        media: [],
        captions: [],
        sources: [],
        type: null,
        caption_available: null,
        next_recheck_at: null,
        recheck_tier: null,
        consecutive_recheck_failures: 2,
        formats: {
          max_height: null,
          max_fps: null,
          has_av1: null,
          has_vp9: null,
          has_h264: null,
          is_hdr: null,
        },
      }),
    );
    expect(wrapper.find("h1").text()).toBe(ID);
    expect(wrapper.find("[data-test='video-channel']").exists()).toBe(false);
    expect(wrapper.find("[data-test='no-media']").exists()).toBe(true);
    expect(wrapper.find("[data-test='player-none']").exists()).toBe(true);
    expect(wrapper.find("[data-test='media-empty']").exists()).toBe(true);
    expect(find(wrapper, "[data-test='formats']").text()).toBe("-");
    expect(find(wrapper, "[data-test='metadata']").text()).toContain("2 failed in a row");
    expect(find(wrapper, "[data-test='sources']").text()).toContain("no account source");
  });

  it("shows HDR and an unrounded frame rate", async () => {
    const wrapper = await mountVideo(
      serve({
        formats: {
          max_height: 1080,
          max_fps: null,
          has_av1: false,
          has_vp9: false,
          has_h264: true,
          is_hdr: true,
        },
      }),
    );
    expect(find(wrapper, "[data-test='formats']").text()).toBe("up to 1080p; H.264; HDR");
  });
});

describe("VideoPage loading states", () => {
  it("shows not found for an unknown video", async () => {
    const server = serve().on("GET", BASE, () => apiError(404, "Video not found.", "not_found"));
    const wrapper = await mountVideo(server);
    expect(find(wrapper, "[data-test='video-not-found']").text()).toContain("Video not found");
    expect(wrapper.find(".error-state").exists()).toBe(false);
  });

  it("does not ask the server about an id that cannot exist", async () => {
    const server = serve();
    const wrapper = await mountVideo(server, "not-an-id");
    expect(wrapper.find("[data-test='video-not-found']").exists()).toBe(true);
    expect(server.callsTo("GET", /^\/api\/videos\//)).toHaveLength(0);
  });

  it("shows an error and retries", async () => {
    let calls = 0;
    const server = serve().on("GET", BASE, () => {
      calls += 1;
      return calls === 1 ? apiError(500, "boom") : json(videoDetail());
    });
    const wrapper = await mountVideo(server);
    expect(find(wrapper, ".error-state h2").text()).toBe("Could not load this video");
    await find(wrapper, ".error-state button").trigger("click");
    await flush(5);
    expect(wrapper.find("h1").text()).toBe("A video about things");
  });

  it("works from a prop without a router", async () => {
    const server = serve();
    const wrapper = mount(VideoPage, {
      props: { id: ID },
      global: { ...mountGlobals({ api: server.api }), stubs: { teleport: true, Chart: true } },
    });
    await flush(5);
    expect(find(wrapper, "[data-test='video-channel'] a").attributes("href")).toBe(
      "/?channel_id=UC0123456789abcdefghijkl",
    );
  });
});

describe("VideoPage actions", () => {
  it("queues a recheck and a download", async () => {
    const server = serve()
      .on("POST", `${BASE}/recheck`, () => json({ job_id: 4, deduped: false }, 202))
      .on("POST", `${BASE}/download-now`, () => json({ job_id: 5, deduped: true }, 202));
    const wrapper = await mountVideo(server);
    await find(wrapper, "[data-action='recheck']").trigger("click");
    await flush();
    expect(toasts.at(-1)).toMatchObject({ summary: "Recheck queued", detail: "Job #4" });
    await find(wrapper, "[data-action='download-now']").trigger("click");
    await flush();
    expect(toasts.at(-1)).toMatchObject({ summary: "Download already queued", detail: "Job #5" });
  });

  it("explains a missing job handler and other failures", async () => {
    const server = serve()
      .on("POST", `${BASE}/recheck`, () => apiError(501, "nope", "not_implemented"))
      .on("POST", `${BASE}/download-now`, () => apiError(500, "broken"));
    const wrapper = await mountVideo(server);
    await find(wrapper, "[data-action='recheck']").trigger("click");
    await flush();
    expect(toasts.at(-1)).toMatchObject({
      severity: "warn",
      summary: "Recheck is not available yet",
    });
    await find(wrapper, "[data-action='download-now']").trigger("click");
    await flush();
    expect(toasts.at(-1)).toMatchObject({
      severity: "error",
      summary: "Could not queue the download",
    });
  });

  it("trashes after confirming, then reloads", async () => {
    const server = serve().on("POST", "/api/videos/trash", () => json({ count: 1 }, 202));
    const wrapper = await mountVideo(server);
    await find(wrapper, "[data-action='trash']").trigger("click");
    await flush();
    expect(find(wrapper, ".p-dialog .confirm-message").text()).toContain(
      "metadata, history and captions are kept",
    );
    const before = server.callsTo("GET", BASE).length;
    await dialogButton(wrapper, "Trash").trigger("click");
    await flush();
    expect(server.callsTo("POST", "/api/videos/trash")[0]!.body).toEqual({ ids: [ID] });
    expect(server.callsTo("GET", BASE).length).toBe(before + 1);
    expect(toasts.at(-1)).toMatchObject({ severity: "success", summary: "Moved to trash" });
  });

  it("toasts a failed trash", async () => {
    const server = serve().on("POST", "/api/videos/trash", () => apiError(501, "Trash later."));
    const wrapper = await mountVideo(server);
    await find(wrapper, "[data-action='trash']").trigger("click");
    await flush();
    await dialogButton(wrapper, "Trash").trigger("click");
    await flush();
    expect(toasts.at(-1)).toMatchObject({ severity: "error", detail: "Trash later." });
  });
});

describe("VideoPage player", () => {
  function videoElement(wrapper: VueWrapper): HTMLVideoElement {
    return find(wrapper, "[data-test='player-video']").element as HTMLVideoElement;
  }

  it("plays the current file with caption tracks and a poster", async () => {
    const wrapper = await mountVideo(serve());
    const video = find(wrapper, "[data-test='player-video']");
    expect(video.attributes("src")).toBe(`${BASE}/media/11`);
    expect(video.attributes("poster")).toBe(`${BASE}/thumbnail/best?sha=abc`);
    const tracks = video.findAll("track");
    expect(tracks.map((track) => track.attributes("srclang"))).toEqual(["de", "en"]);
    expect(tracks[1]!.attributes("src")).toBe(`${BASE}/captions/en`);
    expect(tracks[1]!.attributes("kind")).toBe("subtitles");
    expect(tracks[0]!.attributes("default")).toBeUndefined();
    expect(tracks[1]!.attributes("default")).toBeDefined();
  });

  it("uses an audio player for an audio-only archive", async () => {
    const wrapper = await mountVideo(
      serve({ media: [mediaRow({ id: 12, kind: "audio", rel_path: "a.m4a" })], captions: [] }),
    );
    expect(find(wrapper, "[data-test='player-audio']").attributes("src")).toBe(`${BASE}/media/12`);
    expect(wrapper.find("[data-test='player-video']").exists()).toBe(false);
  });

  it("changes the speed from the menu", async () => {
    const wrapper = await mountVideo(serve());
    wrapper.findAllComponents(Select)[0]!.vm.$emit("update:modelValue", 2);
    await flush();
    expect(videoElement(wrapper).playbackRate).toBe(2);
    videoElement(wrapper).playbackRate = 1;
    await find(wrapper, "[data-test='player-video']").trigger("loadedmetadata");
    expect(videoElement(wrapper).playbackRate).toBe(2);
  });

  it("answers the keyboard shortcuts", async () => {
    const wrapper = await mountVideo(serve());
    const el = videoElement(wrapper);
    const frame = find(wrapper, ".player__frame");
    let paused = true;
    Object.defineProperty(el, "paused", { configurable: true, get: () => paused });
    const play = vi.fn(() => {
      paused = false;
      return Promise.resolve();
    });
    const pause = vi.fn(() => {
      paused = true;
    });
    el.play = play;
    el.pause = pause;

    await frame.trigger("keydown", { key: " " });
    expect(play).toHaveBeenCalledTimes(1);
    await frame.trigger("keydown", { key: "k" });
    expect(pause).toHaveBeenCalledTimes(1);

    el.currentTime = 30;
    await frame.trigger("keydown", { key: "ArrowRight" });
    expect(el.currentTime).toBe(35);
    await frame.trigger("keydown", { key: "j" });
    expect(el.currentTime).toBe(25);
    await frame.trigger("keydown", { key: "l" });
    expect(el.currentTime).toBe(35);
    await frame.trigger("keydown", { key: "ArrowLeft" });
    expect(el.currentTime).toBe(30);
    el.currentTime = 2;
    await frame.trigger("keydown", { key: "j" });
    expect(el.currentTime).toBe(0);

    el.volume = 0.5;
    await frame.trigger("keydown", { key: "ArrowUp" });
    expect(el.volume).toBe(0.6);
    await frame.trigger("keydown", { key: "ArrowDown" });
    await frame.trigger("keydown", { key: "ArrowDown" });
    expect(el.volume).toBe(0.4);

    await frame.trigger("keydown", { key: ">" });
    await flush();
    expect(el.playbackRate).toBe(1.25);
    await frame.trigger("keydown", { key: "<" });
    await frame.trigger("keydown", { key: "<" });
    await flush();
    expect(el.playbackRate).toBe(0.75);

    // Modifiers and unknown keys are left to the browser.
    await frame.trigger("keydown", { key: "k", ctrlKey: true });
    await frame.trigger("keydown", { key: "x" });
    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it("ignores keys typed into a field", async () => {
    const wrapper = await mountVideo(serve());
    const el = videoElement(wrapper);
    const play = vi.fn(() => Promise.resolve());
    el.play = play;
    const input = document.createElement("input");
    find(wrapper, ".player__frame").element.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(play).not.toHaveBeenCalled();
  });
});

describe("VideoPage history and stats", () => {
  it("shows changes as old -> new and hides counter ticks until asked", async () => {
    const server = serve().on("GET", `${BASE}/history`, () =>
      json(
        listPage(
          [
            change({ id: 1, field: "title", old: "Old", new: "New" }),
            change({ id: 2, field: "views", old: 10, new: 20 }),
            change({ id: 3, field: "description", old: "a".repeat(200), new: "b" }),
          ],
          3,
        ),
      ),
    );
    const wrapper = await mountVideo(server);
    const items = () => wrapper.findAll("[data-test='history-item']");
    expect(items().map((item) => item.attributes("data-field"))).toEqual(["title", "description"]);
    const title = items()[0]!;
    expect(title.text()).toContain("Title");
    expect(title.text()).toContain("2 h ago");
    expect(title.find("[data-test='history-old']").text()).toBe("Old");
    expect(title.find("[data-test='history-new']").text()).toBe("New");
    expect(title.text()).toContain("->");
    expect(items()[1]!.find("details").exists()).toBe(true);
    const toggle = find(wrapper, "[data-test='history-counters']");
    expect(toggle.text()).toBe("Show 1 counter change");
    await toggle.trigger("click");
    expect(items()).toHaveLength(3);
    expect(items()[1]!.text()).toContain("10");
    await toggle.trigger("click");
    expect(items()).toHaveLength(2);
  });

  it("pages through older history", async () => {
    const server = serve().on("GET", `${BASE}/history`, (request) =>
      json(
        listPage(
          [change({ id: Number(request.query.get("page")), field: "views" })],
          120,
          Number(request.query.get("page")),
        ),
      ),
    );
    const wrapper = await mountVideo(server);
    expect(find(wrapper, "[data-test='history-only-counters']").exists()).toBe(true);
    expect(find(wrapper, "[data-test='history-page']").text()).toBe("Page 1 of 3");
    expect(find(wrapper, "[data-test='history-newer']").attributes("disabled")).toBeDefined();
    await find(wrapper, "[data-test='history-older']").trigger("click");
    await flush();
    expect(server.callsTo("GET", `${BASE}/history`).at(-1)!.query.get("page")).toBe("2");
    expect(find(wrapper, "[data-test='history-page']").text()).toBe("Page 2 of 3");
    await find(wrapper, "[data-test='history-newer']").trigger("click");
    await flush();
    expect(find(wrapper, "[data-test='history-page']").text()).toBe("Page 1 of 3");
  });

  it("says when there is no history and when it cannot load", async () => {
    const empty = await mountVideo(
      serve().on("GET", `${BASE}/history`, () => json(listPage([], 0))),
    );
    expect(empty.find("[data-test='history-empty']").exists()).toBe(true);
    const failing = await mountVideo(
      serve().on("GET", `${BASE}/history`, () => apiError(500, "boom")),
    );
    expect(find(failing, "[data-test='history'] .error-state h2").text()).toBe(
      "Could not load the history",
    );
  });

  it("charts the counters", async () => {
    const wrapper = await mountVideo(serve());
    const chart = find(wrapper, "[data-test='stats-chart']");
    const data = chart.attributes();
    expect(data.type).toBe("line");
    expect(wrapper.find("[data-test='stats-empty']").exists()).toBe(false);
  });

  it("explains an empty or single-point chart and a failure", async () => {
    const empty = await mountVideo(serve().on("GET", `${BASE}/stats`, () => json({ points: [] })));
    expect(empty.find("[data-test='stats-empty']").exists()).toBe(true);
    expect(empty.find("[data-test='stats-chart']").exists()).toBe(false);
    const single = await mountVideo(
      serve().on("GET", `${BASE}/stats`, () => json({ points: [point(1, 5)] })),
    );
    expect(single.find("[data-test='stats-single']").exists()).toBe(true);
    const failing = await mountVideo(
      serve().on("GET", `${BASE}/stats`, () => apiError(500, "boom")),
    );
    expect(find(failing, "[data-test='stats'] .error-state h2").text()).toBe(
      "Could not load the stats",
    );
  });
});

describe("VideoPage share links", () => {
  it("lists the links from the shares api", async () => {
    const server = serve().on("GET", "/api/shares", () =>
      json(
        listPage(
          [
            shareRow(),
            shareRow({
              token: "tok_revoked",
              status: "revoked",
              revoked_at: 5,
              last_access_at: null,
              created_at: 1,
            }),
          ],
          2,
          1,
          100,
        ),
      ),
    );
    const wrapper = await mountVideo(server);
    expect(server.callsTo("GET", "/api/shares")[0]!.query.get("video_id")).toBe(ID);
    const rows = wrapper.findAll("[data-test='share-table'] tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.find("a").attributes("href")).toBe(shareRow().url);
    expect(rows[0]!.find("[data-test='share-state']").text()).toBe("active");
    expect(rows[0]!.find("[data-test='share-count']").text()).toContain("3");
    expect(rows[0]!.find("[data-test='share-count']").text()).toContain("last 1 min ago");
    expect(rows[1]!.find("[data-test='share-state']").text()).toBe("revoked");
    expect(rows[1]!.find("[data-action='share-revoke']").exists()).toBe(false);
  });

  it("creates a link with an expiry", async () => {
    const server = serve()
      .on("GET", "/api/shares", () => json(listPage([], 0, 1, 100)))
      .on("POST", "/api/shares", () =>
        json(shareRow({ token: "tok_new", url: "https://cellar.test/s/tok_new" }), 201),
      );
    const wrapper = await mountVideo(server);
    expect(wrapper.find("[data-test='share-empty']").exists()).toBe(true);
    const expiry = find(wrapper, "[data-test='share-expiry']");
    await expiry.setValue("2001-01-01T10:00");
    expect(find(wrapper, "[data-test='share-expiry-problem']").text()).toBe(
      "Pick a time in the future.",
    );
    await expiry.setValue("2999-01-01T10:00");
    expect(wrapper.find("[data-test='share-expiry-problem']").exists()).toBe(false);
    await find(wrapper, "[data-test='share-create']").trigger("submit");
    await flush(5);
    const body = server.callsTo("POST", "/api/shares")[0]!.body as Record<string, unknown>;
    expect(body.video_id).toBe(ID);
    expect(body.expires_at).toBe(new Date("2999-01-01T10:00").getTime());
    expect(toasts.find((toast) => toast.summary === "Share link created")?.detail).toBe(
      "https://cellar.test/s/tok_new",
    );
    expect(wrapper.find("[data-token='tok_new']").exists()).toBe(true);
  });

  it("creates a link that never expires and reports a rejected one", async () => {
    let calls = 0;
    const server = serve().on("POST", "/api/shares", () => {
      calls += 1;
      return calls === 1 ? json(shareRow({ token: "tok_2" }), 201) : apiError(400, "Bad.");
    });
    const wrapper = await mountVideo(server);
    await find(wrapper, "[data-test='share-create']").trigger("submit");
    await flush(5);
    expect(
      (server.callsTo("POST", "/api/shares")[0]!.body as Record<string, unknown>).expires_at,
    ).toBeNull();
    await find(wrapper, "[data-test='share-create']").trigger("submit");
    await flush(5);
    expect(toasts.at(-1)).toMatchObject({ severity: "error", detail: "Bad." });
  });

  it("revokes after confirming", async () => {
    const token = shareRow().token;
    const server = serve().on("POST", `/api/shares/${token}/revoke`, () =>
      json(shareRow({ status: "revoked", revoked_at: Date.now() })),
    );
    const wrapper = await mountVideo(server);
    await find(wrapper, "[data-action='share-revoke']").trigger("click");
    await flush();
    await dialogButton(wrapper, "Revoke").trigger("click");
    await flush(5);
    expect(server.callsTo("POST", `/api/shares/${token}/revoke`)).toHaveLength(1);
    expect(find(wrapper, `[data-token='${token}'] [data-test='share-state']`).text()).toBe(
      "revoked",
    );
    expect(toasts.find((toast) => toast.summary === "Share link revoked")).toBeDefined();
  });

  it("toasts a failed revoke", async () => {
    const token = shareRow().token;
    const server = serve().on("POST", `/api/shares/${token}/revoke`, () => apiError(501, "No."));
    const wrapper = await mountVideo(server);
    await find(wrapper, "[data-action='share-revoke']").trigger("click");
    await flush();
    await dialogButton(wrapper, "Revoke").trigger("click");
    await flush();
    expect(toasts.at(-1)).toMatchObject({ severity: "error", detail: "No." });
    expect(find(wrapper, "[data-test='share-unavailable']").exists()).toBe(true);
  });

  it("falls back to the detail rows and turns creating off without a shares api", async () => {
    const server = serve({
      share_links: [
        { token: "tok_old", expires_at: 1, revoked_at: null, access_count: 0, created_at: 1 },
      ],
    }).on("GET", "/api/shares", () => apiError(404, "nope", "not_found"));
    const wrapper = await mountVideo(server);
    expect(find(wrapper, "[data-token='tok_old'] [data-test='share-state']").text()).toBe(
      "expired",
    );
    expect(find(wrapper, "[data-test='share-unavailable']").exists()).toBe(true);
    expect(find(wrapper, "[data-test='share-create-button']").attributes("disabled")).toBeDefined();
  });

  it("keeps creating on when listing fails for another reason, and marks a 501 create", async () => {
    const server = serve()
      .on("GET", "/api/shares", () => apiError(500, "boom"))
      .on("POST", "/api/shares", () => apiError(501, "later", "not_implemented"));
    const wrapper = await mountVideo(server);
    expect(wrapper.find("[data-test='share-unavailable']").exists()).toBe(false);
    expect(wrapper.find("[data-test='share-empty']").exists()).toBe(true);
    await find(wrapper, "[data-test='share-create']").trigger("submit");
    await flush();
    expect(find(wrapper, "[data-test='share-unavailable']").exists()).toBe(true);
  });

  it("copies a link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const wrapper = await mountVideo(serve());
    await find(wrapper, "[data-action='share-copy']").trigger("click");
    await flush();
    expect(writeText).toHaveBeenCalledWith(shareRow().url);
    expect(toasts.at(-1)).toMatchObject({ summary: "Link copied" });
    writeText.mockRejectedValueOnce(new Error("denied"));
    await find(wrapper, "[data-action='share-copy']").trigger("click");
    await flush();
    expect(toasts.at(-1)).toMatchObject({ severity: "warn", summary: "Could not copy" });
  });
});
