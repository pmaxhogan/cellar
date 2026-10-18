import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import SelectButton from "primevue/selectbutton";
import BulkDownloadDialog from "../../src/components/videos/BulkDownloadDialog.vue";
import VideoFiltersBar from "../../src/components/videos/VideoFiltersBar.vue";
import VideoHistory from "../../src/components/videos/VideoHistory.vue";
import VideoShareLinks from "../../src/components/videos/VideoShareLinks.vue";
import VideoStatsChart from "../../src/components/videos/VideoStatsChart.vue";
import { emptyFilters } from "../../src/api/videos.ts";
import type { FsDirectoryHandle } from "../../src/lib/folderDownload.ts";
import { flush } from "../helpers/dom.ts";
import { captureToasts } from "../helpers/adminFetch.ts";
import { fakeServer, json, type FakeServer } from "../helpers/fakeServer.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { change, ID, ID2, listPage, point, shareRow, videoDetail, videoRow } from "./fixtures.ts";

beforeEach(() => {
  captureToasts();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).showDirectoryPicker;
  document.documentElement.style.removeProperty("--p-text-muted-color");
});

/** The first video's requests hang until aborted; the second video's answer at once. */
function hangingFirst(path: (id: string) => string, reply: () => unknown): FakeServer {
  return fakeServer()
    .on("GET", path(ID), () => new Promise<Response>(() => undefined))
    .on("GET", path(ID2), () => json(reply()));
}

function globals(server: FakeServer) {
  const base = mountGlobals({ api: server.api });
  return { ...base, stubs: { ...base.stubs, Chart: true } };
}

describe("detail sections drop a stale load when the video changes", () => {
  it("history", async () => {
    const server = hangingFirst(
      (id) => `/api/videos/${id}/history`,
      () => listPage([change()], 1),
    );
    const wrapper = mount(VideoHistory, { props: { videoId: ID }, global: globals(server) });
    await flush();
    await wrapper.setProps({ videoId: ID2 });
    await flush();
    expect(wrapper.findAll("[data-test='history-item']")).toHaveLength(1);
    expect(wrapper.find(".error-state").exists()).toBe(false);
  });

  it("stats, with theme colors read from the page", async () => {
    document.documentElement.style.setProperty("--p-text-muted-color", "#123456");
    const server = hangingFirst(
      (id) => `/api/videos/${id}/stats`,
      () => ({ points: [point(1, 1), point(2, 2)] }),
    );
    const wrapper = mount(VideoStatsChart, { props: { videoId: ID }, global: globals(server) });
    await flush();
    await wrapper.setProps({ videoId: ID2 });
    await flush();
    expect(wrapper.find("[data-test='stats-chart']").exists()).toBe(true);
    expect(wrapper.find(".error-state").exists()).toBe(false);
  });

  it("share links", async () => {
    const server = fakeServer().on("GET", "/api/shares", (request) =>
      request.query.get("video_id") === ID
        ? new Promise<Response>(() => undefined)
        : json(listPage([shareRow({ video_id: ID2 })], 1, 1, 100)),
    );
    const wrapper = mount(VideoShareLinks, {
      props: { videoId: ID, links: [] },
      global: globals(server),
    });
    await flush();
    await wrapper.setProps({ videoId: ID2 });
    await flush();
    expect(wrapper.findAll("[data-test='share-table'] tbody tr")).toHaveLength(1);
    expect(wrapper.find("[data-test='share-unavailable']").exists()).toBe(false);
  });
});

describe("share link form edges", () => {
  it("rejects an unreadable time and closes the revoke dialog on cancel", async () => {
    const server = fakeServer().on("GET", "/api/shares", () =>
      json(listPage([shareRow()], 1, 1, 100)),
    );
    const wrapper = mount(VideoShareLinks, {
      props: { videoId: ID, links: [] },
      global: globals(server),
    });
    await flush();
    const input = wrapper.find("[data-test='share-expiry']");
    (input.element as HTMLInputElement).value = "";
    Object.defineProperty(input.element, "value", { configurable: true, value: "not a time" });
    await input.trigger("input");
    expect(wrapper.find("[data-test='share-expiry-problem']").text()).toBe(
      "That is not a date and time.",
    );
    await wrapper.find("[data-test='share-create']").trigger("submit");
    await flush();
    expect(server.callsTo("POST", "/api/shares")).toHaveLength(0);

    await wrapper.find("[data-action='share-revoke']").trigger("click");
    await flush();
    expect(wrapper.find(".p-dialog").exists()).toBe(true);
    const cancel = wrapper
      .findAll(".p-dialog button")
      .find((button) => button.text().trim() === "Cancel");
    await cancel!.trigger("click");
    await flush();
    expect(wrapper.find(".p-dialog").exists()).toBe(false);
  });
});

describe("bulk dialog edges", () => {
  function open(server: FakeServer, ids: string[] = [ID]) {
    return mount(BulkDownloadDialog, {
      props: { visible: true, ids, sample: videoRow() },
      global: globals(server),
    });
  }

  it("does not estimate an empty selection", async () => {
    const server = fakeServer();
    const wrapper = open(server, []);
    await flush();
    expect(server.calls).toHaveLength(0);
    expect(wrapper.find("[data-test='bulk-zip']").attributes("disabled")).toBeDefined();
  });

  it("drops a stale estimate when the kind changes", async () => {
    let calls = 0;
    const server = fakeServer().on("POST", "/api/videos/bulk-download/estimate", () => {
      calls += 1;
      return calls === 1
        ? new Promise<Response>(() => undefined)
        : json({ files: 3, bytes: 3, warn: false });
    });
    const wrapper = open(server);
    await flush();
    wrapper.findComponent(SelectButton).vm.$emit("update:modelValue", "all");
    await flush();
    expect(wrapper.find("[data-test='bulk-estimate-text']").text()).toBe("3 files, 3 B");
    expect(wrapper.find("[data-test='bulk-estimate-error']").exists()).toBe(false);
  });

  it("passes the dialog's own open and close through, except mid-download", async () => {
    const folder: FsDirectoryHandle = {
      name: "F",
      getFileHandle: () => new Promise(() => undefined),
    };
    (globalThis as Record<string, unknown>).showDirectoryPicker = vi.fn().mockResolvedValue(folder);
    const server = fakeServer()
      .on("POST", "/api/videos/bulk-download/estimate", () =>
        json({ files: 1, bytes: 1, warn: false }),
      )
      .on("GET", `/api/videos/${ID}`, () => json(videoDetail()))
      .on("GET", `/api/videos/${ID}/media/11`, () => new Response("x"));
    const wrapper = open(server);
    await flush();
    const dialog = wrapper.findComponent(Dialog);
    dialog.vm.$emit("update:visible", true);
    dialog.vm.$emit("update:visible", false);
    expect(wrapper.emitted("update:visible")).toEqual([[true], [false]]);

    await wrapper.find("[data-test='bulk-folder']").trigger("click");
    await flush();
    expect(wrapper.find("[data-state='writing']").text()).toContain("0 B of 95.4 MB");
    dialog.vm.$emit("update:visible", false);
    expect(wrapper.emitted("update:visible")).toHaveLength(2);
    wrapper.unmount();
  });

  it("lists a video without files as skipped", async () => {
    (globalThis as Record<string, unknown>).showDirectoryPicker = vi
      .fn()
      .mockResolvedValue({ name: "F", getFileHandle: vi.fn() });
    const server = fakeServer()
      .on("POST", "/api/videos/bulk-download/estimate", () =>
        json({ files: 1, bytes: 1, warn: false }),
      )
      .on("GET", `/api/videos/${ID}`, () => json(videoDetail({ media: [] })));
    const wrapper = open(server);
    await flush();
    await wrapper.find("[data-test='bulk-folder']").trigger("click");
    await flush(5);
    expect(wrapper.find("[data-state='skipped']").text()).toContain("no files");
  });
});

describe("filters bar edges", () => {
  it("treats a cleared search box as empty", async () => {
    const wrapper = mount(VideoFiltersBar, {
      props: { modelValue: { ...emptyFilters(), q: "x" }, accounts: [], locations: [] },
      global: mountGlobals(),
    });
    wrapper.findComponent(InputText).vm.$emit("update:modelValue", undefined);
    await wrapper.find("[data-test='video-search']").trigger("keyup", { key: "Enter" });
    const events = wrapper.emitted("update:modelValue") as { q: string }[][];
    expect(events.at(-1)![0]!.q).toBe("");
  });
});
