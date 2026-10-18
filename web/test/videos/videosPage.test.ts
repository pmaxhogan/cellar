import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import DataTable from "primevue/datatable";
import type { VideoRow } from "@cellar/shared";
import VideosPage from "../../src/pages/VideosPage.vue";
import VideoFiltersBar from "../../src/components/videos/VideoFiltersBar.vue";
import BulkDownloadDialog from "../../src/components/videos/BulkDownloadDialog.vue";
import { emptyFilters } from "../../src/api/videos.ts";
import { routes } from "../../src/router/index.ts";
import { flush } from "../helpers/dom.ts";
import {
  apiError,
  captureToasts,
  fakeServer,
  json,
  type CapturedToast,
  type FakeServer,
  type RecordedCall,
} from "../helpers/adminFetch.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { fakeServer as abortingServer, json as reply } from "../helpers/fakeServer.ts";
import { account, ID, ID2, idFor, listPage, location, videoRow } from "./fixtures.ts";

// A small bulk limit keeps the "capped" case to a few pages of fake rows.
vi.mock("@cellar/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cellar/shared")>()),
  MAX_BULK_IDS: 300,
}));

let toasts: CapturedToast[];

beforeEach(() => {
  toasts = captureToasts();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function lookups(): Record<string, () => unknown> {
  return {
    "GET /api/accounts": () => ({ rows: [account()] }),
    "GET /api/locations": () => ({ rows: [location()] }),
  };
}

function serve(rows: VideoRow[], total = rows.length): FakeServer {
  return fakeServer({
    ...lookups(),
    "GET /api/videos": (call) =>
      listPage(
        rows,
        total,
        Number(call.query.get("page") ?? 1),
        Number(call.query.get("perPage") ?? 50),
      ),
  });
}

async function mountAt(
  server: FakeServer,
  path = "/",
): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(path);
  await router.isReady();
  const wrapper = mount(VideosPage, { global: mountGlobals({ api: server.api, router }) });
  await flush();
  return { wrapper, router };
}

function lastList(server: FakeServer): RecordedCall {
  const calls = server.callsTo("GET /api/videos");
  return calls[calls.length - 1]!;
}

function button(wrapper: VueWrapper, selector: string) {
  const found = wrapper.find(selector);
  if (!found.exists()) throw new Error(`missing ${selector}`);
  return found;
}

async function check(wrapper: VueWrapper, selector: string): Promise<void> {
  await button(wrapper, `${selector} input`).trigger("change");
  await flush();
}

function dialogButton(wrapper: VueWrapper, label: string) {
  const found = wrapper
    .findAll(".p-dialog button")
    .find((candidate) => candidate.text().trim() === label);
  if (found === undefined) throw new Error(`no dialog button labelled ${label}`);
  return found;
}

describe("VideosPage list", () => {
  it("loads the first page and renders every column", async () => {
    const server = serve([
      videoRow(),
      videoRow({
        id: ID2,
        title: null,
        channel_title: null,
        thumbnail_url: null,
        privacy: "removed",
        downloaded: false,
        reclaim_priority: -1,
        sources: [],
      }),
    ]);
    const { wrapper } = await mountAt(server);
    const call = lastList(server);
    expect(call.query.get("page")).toBe("1");
    expect(call.query.get("perPage")).toBe("50");
    expect(call.query.has("sort")).toBe(false);

    const rows = wrapper.findAll("tbody tr");
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(first.find("img").attributes("src")).toBe(`/api/videos/${ID}/thumbnail/best?sha=abc`);
    const link = first.find(`[data-video='${ID}']`);
    expect(link.text()).toBe("A video about things");
    expect(link.attributes("href")).toBe(`/videos/${ID}`);
    expect(first.text()).toContain("Tech Channel");
    expect(first.text()).toContain("2024-03-05");
    expect(first.text()).toContain("4:05");
    expect(first.find("[data-test='source-chip']").text()).toBe("Liked (main)");
    expect(first.find("[data-test='status']").text()).toBe("public");
    expect(first.find("[data-test='downloaded']").text()).toBe("100 MB");
    expect(first.find("[data-test='priority']").text()).toBe("5");
    expect(first.text()).toContain("12,345");

    const second = rows[1]!;
    expect(second.find("img").exists()).toBe(false);
    expect(second.find(`[data-video='${ID2}']`).text()).toBe(ID2);
    expect(second.find("[data-test='status']").text()).toBe("gone");
    expect(second.find("[data-test='downloaded']").text()).toBe("-");
    expect(second.find("[data-test='priority']").text()).toBe("keep forever");
    expect(wrapper.find("[data-test='video-total']").text()).toBe("2 videos");
  });

  it("shows the empty state when the catalog is empty", async () => {
    const { wrapper } = await mountAt(serve([]));
    expect(wrapper.find(".empty-state h2").text()).toBe("No videos yet");
  });

  it("shows an error state and retries", async () => {
    let calls = 0;
    const server = fakeServer({
      ...lookups(),
      "GET /api/videos": () => {
        calls += 1;
        return calls === 1 ? apiError(503, "starting up") : listPage([videoRow()]);
      },
    });
    const { wrapper } = await mountAt(server);
    expect(wrapper.find(".error-state h2").text()).toBe("Could not load videos");
    await wrapper.find(".error-state button").trigger("click");
    await flush();
    expect(wrapper.find(".error-state").exists()).toBe(false);
    expect(wrapper.findAll("tbody tr")).toHaveLength(1);
  });

  it("reads its state from the URL", async () => {
    const server = serve([videoRow()], 400);
    await mountAt(server, "/?q=cats&status=gone,private&sort=views&dir=asc&page=2&perPage=100");
    const call = lastList(server);
    expect(call.query.get("q")).toBe("cats");
    expect(call.query.get("status")).toBe("gone,private");
    expect(call.query.get("sort")).toBe("views");
    expect(call.query.get("dir")).toBe("asc");
    expect(call.query.get("page")).toBe("2");
    expect(call.query.get("perPage")).toBe("100");
  });

  it("pages and sorts on the server and mirrors both into the URL", async () => {
    const server = serve([videoRow()], 400);
    const { wrapper, router } = await mountAt(server);
    const table = wrapper.findComponent(DataTable);

    table.vm.$emit("page", { page: 2, rows: 100 });
    await flush();
    expect(lastList(server).query.get("page")).toBe("3");
    expect(lastList(server).query.get("perPage")).toBe("100");
    expect(router.currentRoute.value.query).toEqual({ page: "3", perPage: "100" });

    table.vm.$emit("sort", { sortField: "upload_date", sortOrder: 1 });
    await flush();
    expect(lastList(server).query.get("sort")).toBe("upload_date");
    expect(lastList(server).query.get("dir")).toBe("asc");
    expect(lastList(server).query.get("page")).toBe("1");
    expect(router.currentRoute.value.query).toEqual({
      perPage: "100",
      sort: "upload_date",
      dir: "asc",
    });

    table.vm.$emit("sort", { sortField: "views", sortOrder: -1 });
    await flush();
    expect(lastList(server).query.get("dir")).toBe("desc");
    expect(table.props("sortOrder")).toBe(-1);

    table.vm.$emit("sort", { sortField: null, sortOrder: 0 });
    await flush();
    expect(lastList(server).query.has("sort")).toBe(false);
    expect(router.currentRoute.value.query).toEqual({ perPage: "100" });
  });

  it("applies filters, resets to page 1 and keeps them in the URL", async () => {
    const server = serve([videoRow()], 400);
    const { wrapper, router } = await mountAt(server, "/?page=4");
    wrapper.findComponent(VideoFiltersBar).vm.$emit("update:modelValue", {
      ...emptyFilters(),
      source: ["liked"],
      downloaded: "yes",
      pri: "0",
    });
    await flush();
    const call = lastList(server);
    expect(call.query.get("source")).toBe("liked");
    expect(call.query.get("downloaded")).toBe("true");
    expect(call.query.get("pri")).toBe("0");
    expect(call.query.get("page")).toBe("1");
    expect(router.currentRoute.value.query).toEqual({
      source: "liked",
      downloaded: "yes",
      pri: "0",
    });
  });

  it("follows back and forward navigation", async () => {
    const server = serve([videoRow()], 400);
    const { router } = await mountAt(server);
    const before = server.callsTo("GET /api/videos").length;
    await router.push("/?q=dogs");
    await flush();
    expect(server.callsTo("GET /api/videos")).toHaveLength(before + 1);
    expect(lastList(server).query.get("q")).toBe("dogs");
    // The same state again does not reload.
    await router.replace("/?q=dogs&page=1");
    await flush();
    expect(server.callsTo("GET /api/videos")).toHaveLength(before + 1);
  });

  it("aborts a load that a newer one replaces", async () => {
    let calls = 0;
    const server = fakeServer({
      ...lookups(),
      "GET /api/videos": () => {
        calls += 1;
        return calls === 1 ? new Promise(() => undefined) : listPage([videoRow()]);
      },
    });
    const { wrapper } = await mountAt(server);
    wrapper.findComponent(DataTable).vm.$emit("page", { page: 1, rows: 50 });
    await flush();
    const [firstCall] = server.callsTo("GET /api/videos");
    expect(firstCall!.signal!.aborted).toBe(true);
    expect(wrapper.findAll("tbody tr")).toHaveLength(1);
  });

  it("offers to clear filters when nothing matches", async () => {
    const server = serve([], 0);
    const { wrapper, router } = await mountAt(server, "/?status=gone");
    expect(wrapper.find("[data-test='no-matches']").exists()).toBe(true);
    await wrapper.find("[data-test='no-matches'] button").trigger("click");
    await flush();
    expect(router.currentRoute.value.query).toEqual({});
    expect(lastList(server).query.has("status")).toBe(false);
  });

  it("survives a client that answers nothing", async () => {
    const server = fakeServer({ ...lookups(), "GET /api/videos": () => json(null) });
    const { wrapper } = await mountAt(server);
    expect(wrapper.find(".error-state").exists()).toBe(true);
  });
});

describe("VideosPage selection and bulk actions", () => {
  const rows = [videoRow(), videoRow({ id: ID2, title: "Second" })];

  it("selects rows, then the page, and clears", async () => {
    const { wrapper } = await mountAt(serve(rows));
    expect(wrapper.find("[data-test='bulk-toolbar']").exists()).toBe(false);
    await check(wrapper, `[data-select='${ID}']`);
    expect(wrapper.find("[data-test='selected-count']").text()).toBe("1 video selected");
    await check(wrapper, `[data-select='${ID}']`);
    expect(wrapper.find("[data-test='bulk-toolbar']").exists()).toBe(false);
    await check(wrapper, "[data-test='select-page']");
    expect(wrapper.find("[data-test='selected-count']").text()).toBe("2 videos selected");
    await check(wrapper, "[data-test='select-page']");
    expect(wrapper.find("[data-test='bulk-toolbar']").exists()).toBe(false);
    await check(wrapper, "[data-test='select-page']");
    await button(wrapper, "[data-action='clear-selection']").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='bulk-toolbar']").exists()).toBe(false);
  });

  it("trashes the selection after a confirmation that explains what is kept", async () => {
    const server = serve(rows);
    server.on("POST /api/videos/trash", () => json({ count: 2 }, 202));
    const { wrapper } = await mountAt(server);
    await check(wrapper, "[data-test='select-page']");
    await button(wrapper, "[data-action='trash']").trigger("click");
    await flush();
    const message = wrapper.find(".p-dialog .confirm-message").text();
    expect(message).toContain("Trash 2 videos?");
    expect(message).toContain(
      "sets priority 0 and deletes the media now; metadata, history and captions are kept",
    );
    const before = server.callsTo("GET /api/videos").length;
    await dialogButton(wrapper, "Trash").trigger("click");
    await flush();
    expect(server.callsTo("POST /api/videos/trash")[0]!.body).toEqual({ ids: [ID, ID2] });
    expect(toasts.at(-1)).toMatchObject({ severity: "success", summary: "Moved to trash" });
    expect(server.callsTo("GET /api/videos").length).toBe(before + 1);
    expect(wrapper.find("[data-test='bulk-toolbar']").exists()).toBe(false);
  });

  it("keeps the selection and toasts when trash fails", async () => {
    const server = serve(rows);
    server.on("POST /api/videos/trash", () => apiError(501, "Trash is not available yet."));
    const { wrapper } = await mountAt(server);
    await check(wrapper, `[data-select='${ID}']`);
    await button(wrapper, "[data-action='trash']").trigger("click");
    await flush();
    await dialogButton(wrapper, "Trash").trigger("click");
    await flush();
    expect(toasts.at(-1)).toMatchObject({
      severity: "error",
      detail: "Trash is not available yet.",
    });
    expect(wrapper.find("[data-test='selected-count']").text()).toBe("1 video selected");
  });

  it("selects every match across pages", async () => {
    const all = Array.from({ length: 120 }, (_, i) => videoRow({ id: idFor(i) }));
    const server = fakeServer({
      ...lookups(),
      "GET /api/videos": (call) => {
        const page = Number(call.query.get("page"));
        const perPage = Number(call.query.get("perPage"));
        return listPage(all.slice((page - 1) * perPage, page * perPage), 120, page, perPage);
      },
    });
    const { wrapper } = await mountAt(server, "/?status=public");
    await check(wrapper, "[data-test='select-page']");
    expect(wrapper.find("[data-test='select-all-banner']").text()).toContain(
      "All 50 on this page are selected.",
    );
    await button(wrapper, "[data-action='select-all-matching']").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='selected-count']").text()).toBe("120 videos selected");
    expect(wrapper.find("[data-test='select-all-banner']").exists()).toBe(false);
    const collect = server
      .callsTo("GET /api/videos")
      .filter((c) => c.query.get("perPage") === "200");
    expect(collect).toHaveLength(1);
    expect(collect[0]!.query.get("status")).toBe("public");
  });

  it("can stop collecting every match", async () => {
    const server = fakeServer({
      ...lookups(),
      "GET /api/videos": (call) =>
        call.query.get("perPage") === "200"
          ? new Promise(() => undefined)
          : listPage([videoRow()], 900),
    });
    const { wrapper } = await mountAt(server);
    await check(wrapper, "[data-test='select-page']");
    await button(wrapper, "[data-action='select-all-matching']").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='collecting']").text()).toContain("Selecting");
    await button(wrapper, "[data-action='cancel-collect']").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='collecting']").exists()).toBe(false);
    expect(wrapper.find("[data-test='selected-count']").text()).toBe("1 video selected");
  });

  it("reports a failure to collect every match", async () => {
    const server = fakeServer({
      ...lookups(),
      "GET /api/videos": (call) =>
        call.query.get("perPage") === "200" ? apiError(500, "boom") : listPage([videoRow()], 900),
    });
    const { wrapper } = await mountAt(server);
    await check(wrapper, "[data-test='select-page']");
    await button(wrapper, "[data-action='select-all-matching']").trigger("click");
    await flush();
    expect(toasts.at(-1)).toMatchObject({
      severity: "error",
      summary: "Could not select every match",
    });
  });

  it("queues recheck and download now for each selected video", async () => {
    const server = serve(rows);
    server.on(`POST /api/videos/${ID}/recheck`, () => json({ job_id: 1, deduped: false }, 202));
    server.on(`POST /api/videos/${ID2}/recheck`, () => json({ job_id: 2, deduped: true }, 202));
    server.on(`POST /api/videos/${ID}/download-now`, () =>
      apiError(501, "Download is not available yet.", "not_implemented"),
    );
    server.on(`POST /api/videos/${ID2}/download-now`, () =>
      apiError(501, "Download is not available yet.", "not_implemented"),
    );
    const { wrapper } = await mountAt(server);
    await check(wrapper, "[data-test='select-page']");
    await button(wrapper, "[data-action='bulk-recheck']").trigger("click");
    await flush();
    expect(toasts.at(-1)).toMatchObject({
      severity: "success",
      summary: "Recheck queued",
      detail: "2 jobs queued (1 already queued).",
    });
    await button(wrapper, "[data-action='bulk-download-now']").trigger("click");
    await flush();
    expect(toasts.at(-1)).toMatchObject({
      severity: "warn",
      summary: "Download is not available yet",
    });
  });

  it("reports partial failures of a bulk job", async () => {
    const server = serve(rows);
    server.on(`POST /api/videos/${ID}/recheck`, () => json({ job_id: 1, deduped: false }, 202));
    server.on(`POST /api/videos/${ID2}/recheck`, () => apiError(404, "Video not found."));
    const { wrapper } = await mountAt(server);
    await check(wrapper, "[data-test='select-page']");
    await button(wrapper, "[data-action='bulk-recheck']").trigger("click");
    await flush();
    expect(toasts.at(-1)).toMatchObject({
      severity: "warn",
      summary: "Recheck queued with errors",
      detail: "1 job queued, 1 failed: Video not found.",
    });
  });

  it("opens the bulk download dialog with the selection", async () => {
    const server = serve(rows);
    server.on("POST /api/videos/bulk-download/estimate", () =>
      json({ files: 1, bytes: 10, warn: false }),
    );
    const { wrapper } = await mountAt(server);
    await check(wrapper, `[data-select='${ID2}']`);
    await button(wrapper, "[data-action='bulk-download']").trigger("click");
    await flush();
    const dialog = wrapper.findComponent(BulkDownloadDialog);
    expect(dialog.props("visible")).toBe(true);
    expect(dialog.props("ids")).toEqual([ID2]);
    expect(dialog.props("sample")?.title).toBe("Second");
  });

  it("ignores a collection that finishes after it was stopped", async () => {
    const server = fakeServer({
      ...lookups(),
      "GET /api/videos": (call) =>
        call.query.get("perPage") === "200"
          ? new Promise((resolve) =>
              setTimeout(() => resolve(listPage([videoRow(), videoRow({ id: ID2 })], 2)), 20),
            )
          : listPage([videoRow()], 900),
    });
    const { wrapper } = await mountAt(server);
    await check(wrapper, "[data-test='select-page']");
    await button(wrapper, "[data-action='select-all-matching']").trigger("click");
    await button(wrapper, "[data-action='cancel-collect']").trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 40));
    await flush();
    expect(wrapper.find("[data-test='selected-count']").text()).toBe("1 video selected");
  });

  it("says when a selection is capped at the bulk limit", async () => {
    const total = 450;
    const server = fakeServer({
      ...lookups(),
      "GET /api/videos": (call) => {
        const page = Number(call.query.get("page"));
        const perPage = Number(call.query.get("perPage"));
        const rows = Array.from({ length: perPage }, (_, i) =>
          videoRow({ id: idFor((page - 1) * perPage + i) }),
        );
        return listPage(rows, total, page, perPage);
      },
    });
    const { wrapper } = await mountAt(server);
    await check(wrapper, "[data-test='select-page']");
    expect(wrapper.find("[data-action='select-all-matching']").text()).toBe(
      "Select all 300 matching",
    );
    await button(wrapper, "[data-action='select-all-matching']").trigger("click");
    await flush(10);
    expect(wrapper.find("[data-test='selected-count']").text()).toBe("300 videos selected");
    expect(wrapper.find("[data-test='selection-capped']").text()).toContain("the first 300 of 450");
  });

  it("queues download now without duplicates", async () => {
    const server = serve([videoRow()]);
    server.on(`POST /api/videos/${ID}/download-now`, () =>
      json({ job_id: 3, deduped: false }, 202),
    );
    const { wrapper } = await mountAt(server);
    await check(wrapper, `[data-select='${ID}']`);
    await button(wrapper, "[data-action='bulk-download-now']").trigger("click");
    await flush();
    expect(toasts.at(-1)).toMatchObject({ summary: "Download queued", detail: "1 job queued." });
  });
});

describe("VideosPage without a router or with a real abort", () => {
  it("links titles with plain anchors when no router is installed", async () => {
    const server = serve([videoRow()]);
    const wrapper = mount(VideosPage, { global: mountGlobals({ api: server.api }) });
    await flush();
    expect(wrapper.find(`a[data-video='${ID}']`).attributes("href")).toBe(`/videos/${ID}`);
    wrapper.findComponent(DataTable).vm.$emit("page", { page: 1, rows: 50 });
    await flush();
    expect(lastList(server).query.get("page")).toBe("2");
  });

  it("swallows the abort of a replaced load", async () => {
    let calls = 0;
    const server = abortingServer()
      .on("GET", "/api/videos", () => {
        calls += 1;
        return calls === 1 ? new Promise<Response>(() => undefined) : reply(listPage([videoRow()]));
      })
      .on("GET", "/api/accounts", () => reply({ rows: [] }))
      .on("GET", "/api/locations", () => reply({ rows: [] }));
    const wrapper = mount(VideosPage, { global: mountGlobals({ api: server.api }) });
    await flush();
    wrapper.findComponent(DataTable).vm.$emit("page", { page: 1, rows: 50 });
    await flush();
    expect(wrapper.find(".error-state").exists()).toBe(false);
    expect(wrapper.findAll("tbody tr")).toHaveLength(1);
  });
});
