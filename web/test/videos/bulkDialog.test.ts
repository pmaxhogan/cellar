import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import SelectButton from "primevue/selectbutton";
import BulkDownloadDialog from "../../src/components/videos/BulkDownloadDialog.vue";
import { submitZipDownload } from "../../src/lib/bulkDownload.ts";
import type { FsDirectoryHandle, FsWritable } from "../../src/lib/folderDownload.ts";
import { flush } from "../helpers/dom.ts";
import { captureToasts, type CapturedToast } from "../helpers/adminFetch.ts";
import { apiError, fakeServer, json, type FakeServer } from "../helpers/fakeServer.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { ID, ID2, mediaRow, videoDetail, videoRow } from "./fixtures.ts";

vi.mock("../../src/lib/bulkDownload.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/bulkDownload.ts")>()),
  submitZipDownload: vi.fn(),
}));

let toasts: CapturedToast[];

beforeEach(() => {
  toasts = captureToasts();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(submitZipDownload).mockReset();
  delete (globalThis as Record<string, unknown>).showDirectoryPicker;
});

function estimating(server: FakeServer, reply = { files: 2, bytes: 1610612736, warn: false }) {
  return server.on("POST", "/api/videos/bulk-download/estimate", () => json(reply));
}

async function open(server: FakeServer, ids: string[] = [ID, ID2]): Promise<VueWrapper> {
  const wrapper = mount(BulkDownloadDialog, {
    props: { visible: true, ids, sample: videoRow() },
    global: mountGlobals({ api: server.api }),
  });
  await flush();
  return wrapper;
}

function footer(wrapper: VueWrapper, selector: string) {
  const found = wrapper.find(selector);
  if (!found.exists()) throw new Error(`missing ${selector}`);
  return found;
}

describe("BulkDownloadDialog estimate and template", () => {
  it("estimates on open and again when the kind changes", async () => {
    const server = estimating(fakeServer());
    const wrapper = await open(server);
    expect(wrapper.find("[data-test='bulk-count']").text()).toBe("2 videos selected.");
    expect(wrapper.find("[data-test='bulk-estimate-text']").text()).toBe("2 files, 1.50 GB");
    expect(server.callsTo("POST", "/api/videos/bulk-download/estimate")[0]!.body).toEqual({
      ids: [ID, ID2],
      kind: "video",
    });
    wrapper.findComponent(SelectButton).vm.$emit("update:modelValue", "captions");
    await flush();
    const calls = server.callsTo("POST", "/api/videos/bulk-download/estimate");
    expect(calls.at(-1)!.body).toEqual({ ids: [ID, ID2], kind: "captions" });
    expect(wrapper.find("[data-test='bulk-preview-name']").text()).toBe(
      `A video about things [${ID}].en.vtt`,
    );
    expect(wrapper.find("[data-test='bulk-warn']").exists()).toBe(false);
  });

  it("warns above the configured size", async () => {
    const wrapper = await open(
      estimating(fakeServer(), { files: 900, bytes: 25_000_000_000, warn: true }),
    );
    const warn = wrapper.find("[data-test='bulk-warn']");
    expect(warn.text()).toContain("Warning:");
    expect(warn.text()).toContain("23.3 GB");
  });

  it("blocks the download when nothing is on disk", async () => {
    const wrapper = await open(estimating(fakeServer(), { files: 0, bytes: 0, warn: false }));
    expect(wrapper.find("[data-test='bulk-nothing']").exists()).toBe(true);
    expect(footer(wrapper, "[data-test='bulk-zip']").attributes("disabled")).toBeDefined();
  });

  it("shows an estimate failure and retries", async () => {
    let calls = 0;
    const server = fakeServer().on("POST", "/api/videos/bulk-download/estimate", () => {
      calls += 1;
      return calls === 1 ? apiError(500, "boom") : json({ files: 1, bytes: 5, warn: false });
    });
    const wrapper = await open(server);
    expect(wrapper.find("[data-test='bulk-estimate-error']").text()).toContain("boom");
    await wrapper.find("[data-test='bulk-estimate-error'] button").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='bulk-estimate-text']").text()).toBe("1 file, 5 B");
  });

  it("does not estimate while closed", async () => {
    const server = estimating(fakeServer());
    const wrapper = mount(BulkDownloadDialog, {
      props: { visible: false, ids: [ID], sample: null },
      global: mountGlobals({ api: server.api }),
    });
    await flush();
    expect(server.calls).toHaveLength(0);
    await wrapper.setProps({ visible: true });
    await flush();
    expect(server.calls).toHaveLength(1);
    expect(wrapper.find("[data-test='bulk-preview']").exists()).toBe(false);
  });

  it("previews the template live and offers the fields", async () => {
    const wrapper = await open(estimating(fakeServer()));
    expect(wrapper.find("[data-test='bulk-preview-name']").text()).toBe(
      `A video about things [${ID}].mp4`,
    );
    const input = wrapper.find("[data-test='bulk-template']");
    await input.setValue("{channel} - ");
    await wrapper.find("[data-field='upload_date']").trigger("click");
    expect((input.element as HTMLInputElement).value).toBe("{channel} - {upload_date}");
    expect(wrapper.find("[data-test='bulk-preview-name']").text()).toBe(
      "Tech Channel - 2024-03-05.mp4",
    );
    expect(wrapper.findAll("[data-field]")).toHaveLength(8);
    await input.setValue("   ");
    expect(wrapper.find("[data-test='bulk-template-problem']").exists()).toBe(true);
    expect(footer(wrapper, "[data-test='bulk-zip']").attributes("disabled")).toBeDefined();
  });
});

describe("BulkDownloadDialog ZIP", () => {
  it("posts the form and closes", async () => {
    const wrapper = await open(estimating(fakeServer()));
    await wrapper.find("[data-test='bulk-template']").setValue("{id}.{ext}");
    expect(wrapper.find("[data-test='bulk-folder']").exists()).toBe(false);
    await footer(wrapper, "[data-test='bulk-zip']").trigger("click");
    expect(submitZipDownload).toHaveBeenCalledWith({
      ids: [ID, ID2],
      kind: "video",
      template: "{id}.{ext}",
    });
    expect(wrapper.emitted("update:visible")).toEqual([[false]]);
    expect(toasts.at(-1)).toMatchObject({ severity: "info", summary: "Download started" });
  });
});

// --- folder -------------------------------------------------------------------

function folder(): FsDirectoryHandle & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    name: "Archive",
    files,
    async getFileHandle(name) {
      return {
        async createWritable() {
          const parts: string[] = [];
          const writable: FsWritable = {
            async write(data) {
              parts.push(data instanceof Blob ? await data.text() : String(data));
            },
            async close() {
              files.set(name, parts.join(""));
            },
          };
          return writable;
        },
      };
    },
  };
}

function withVideos(server: FakeServer): FakeServer {
  return server
    .on("GET", `/api/videos/${ID}`, () => json(videoDetail()))
    .on("GET", `/api/videos/${ID2}`, () =>
      json(videoDetail({ id: ID2, title: "Second", media: [mediaRow({ id: 21 })] })),
    )
    .on("GET", `/api/videos/${ID}/media/11`, () => new Response("one"))
    .on("GET", `/api/videos/${ID2}/media/21`, () => new Response("two"));
}

describe("BulkDownloadDialog save to folder", () => {
  it("writes each file into the picked folder with a progress list", async () => {
    const target = folder();
    (globalThis as Record<string, unknown>).showDirectoryPicker = vi.fn().mockResolvedValue(target);
    const wrapper = await open(withVideos(estimating(fakeServer())));
    await footer(wrapper, "[data-test='bulk-folder']").trigger("click");
    await flush(6);
    expect([...target.files.entries()]).toEqual([
      [`A video about things [${ID}].mkv`, "one"],
      [`Second [${ID2}].mkv`, "two"],
    ]);
    const items = wrapper.findAll("[data-test='bulk-progress-item']");
    expect(items.map((item) => item.attributes("data-state"))).toEqual(["done", "done"]);
    expect(items[0]!.text()).toContain("3 B");
    expect(wrapper.find("[data-test='bulk-summary']").text()).toBe("2 files written to Archive.");
    expect(toasts.at(-1)).toMatchObject({
      severity: "success",
      summary: "Folder download finished",
    });
  });

  it("reports failed files", async () => {
    (globalThis as Record<string, unknown>).showDirectoryPicker = vi
      .fn()
      .mockResolvedValue(folder());
    const server = withVideos(estimating(fakeServer())).on(
      "GET",
      `/api/videos/${ID2}/media/21`,
      () => apiError(500, "disk"),
    );
    const wrapper = await open(server);
    await footer(wrapper, "[data-test='bulk-folder']").trigger("click");
    await flush(6);
    const failed = wrapper.find("[data-state='failed']");
    expect(failed.text()).toContain("disk");
    expect(wrapper.find("[data-test='bulk-summary']").text()).toBe(
      "1 file written to Archive, 1 file failed.",
    );
    expect(toasts.at(-1)).toMatchObject({ severity: "warn" });
  });

  it("can be canceled", async () => {
    (globalThis as Record<string, unknown>).showDirectoryPicker = vi
      .fn()
      .mockResolvedValue(folder());
    const server = withVideos(estimating(fakeServer())).on(
      "GET",
      `/api/videos/${ID}/media/11`,
      () => new Promise<Response>(() => undefined),
    );
    const wrapper = await open(server);
    await footer(wrapper, "[data-test='bulk-folder']").trigger("click");
    await flush();
    expect(wrapper.find("[data-state='writing']").exists()).toBe(true);
    // The dialog cannot be closed mid-download.
    wrapper.vm.$emit("update:visible", false);
    await footer(wrapper, "[data-test='bulk-cancel']").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='bulk-summary']").text()).toBe(
      "0 files written to Archive, canceled.",
    );
    expect(toasts.at(-1)).toMatchObject({ severity: "warn", summary: "Folder download canceled" });
    expect(server.callsTo("GET", `/api/videos/${ID2}`)).toHaveLength(0);
  });

  it("does nothing when the picker is dismissed", async () => {
    (globalThis as Record<string, unknown>).showDirectoryPicker = vi
      .fn()
      .mockRejectedValue(new DOMException("no", "AbortError"));
    const server = estimating(fakeServer());
    const wrapper = await open(server);
    await footer(wrapper, "[data-test='bulk-folder']").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='bulk-progress']").exists()).toBe(false);
    expect(server.calls).toHaveLength(1);
  });
});
