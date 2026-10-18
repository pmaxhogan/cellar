import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import Select from "primevue/select";
import TakeoutPage from "../../src/pages/TakeoutPage.vue";
import TakeoutDropZone from "../../src/components/takeout/TakeoutDropZone.vue";
import TakeoutHistory from "../../src/components/takeout/TakeoutHistory.vue";
import { useEventsStore } from "../../src/stores/events.ts";
import { flush } from "../helpers/dom.ts";
import { apiError, fakeServer, type FakeServer } from "../helpers/adminFetch.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { account, counts, FakeXhr, importActivity, jobResponse, preview } from "./fixtures.ts";

let pinia: Pinia;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  FakeXhr.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function server(overrides: Record<string, () => unknown> = {}): FakeServer {
  return fakeServer({
    "GET /api/accounts": () => ({
      rows: [account(1, "Main", "main@example.com"), account(2, "Alt")],
    }),
    "GET /api/activity": () => ({ rows: [], total: 0, page: 1, perPage: 20 }),
    "GET /api/takeout/7": () => jobResponse(),
    ...overrides,
  });
}

async function mountPage(fake: FakeServer): Promise<VueWrapper> {
  const wrapper = mount(TakeoutPage, { global: mountGlobals({ api: fake.api, pinia }) });
  await flush();
  return wrapper;
}

function file(name: string, body = "{}"): File {
  return new File([body], name);
}

async function addFiles(wrapper: VueWrapper, files: File[]): Promise<void> {
  wrapper.findComponent(TakeoutDropZone).vm.$emit("add", files);
  await flush();
}

function emit(type: string, payload: unknown): void {
  useEventsStore(pinia).dispatch({ type, at: Date.now(), payload });
}

async function uploadTo(wrapper: VueWrapper): Promise<FakeXhr> {
  await addFiles(wrapper, [file("takeout-20261018T000000Z-001.tgz", "x".repeat(10))]);
  await wrapper.find("[data-action='upload']").trigger("click");
  await flush();
  return FakeXhr.last();
}

describe("TakeoutPage", () => {
  it("shows the exact export checklist", async () => {
    const wrapper = await mountPage(server());
    expect(wrapper.find("h1").text()).toBe("Takeout");
    const steps = wrapper.findAll("[data-test='takeout-steps'] li").map((li) => li.text());
    expect(steps).toEqual([
      "Google Takeout",
      "Deselect all",
      "tick 'YouTube and YouTube Music'",
      "'All YouTube data included'",
      "keep only history, playlists, subscriptions",
      "'Multiple formats'",
      "set history to JSON (the default HTML cannot be imported; playlists and subscriptions are CSV only)",
      "export (a .tgz or .zip)",
    ]);
    expect(wrapper.find("[data-test='takeout-link']").attributes("href")).toBe(
      "https://takeout.google.com/",
    );
  });

  it("lists the accounts and preselects the first", async () => {
    const wrapper = await mountPage(server());
    const select = wrapper.findComponent(Select);
    expect(select.props("modelValue")).toBe(1);
    expect(select.props("options")).toEqual([
      { value: 1, label: "Main (main@example.com)" },
      { value: 2, label: "Alt" },
    ]);
  });

  it("asks for an account when there is none, and reports a load failure", async () => {
    const empty = await mountPage(server({ "GET /api/accounts": () => ({ rows: [] }) }));
    expect(empty.find("[data-test='no-accounts']").text()).toContain("Add an account first");
    expect(empty.find("[data-action='upload']").attributes("disabled")).toBeDefined();

    const broken = await mountPage(
      server({ "GET /api/accounts": () => apiError(500, "internal error") }),
    );
    expect(broken.find(".error-state").text()).toContain("Could not load accounts");
  });

  it("uploads with progress, previews, follows the job and shows the counts", async () => {
    const fake = server();
    const wrapper = await mountPage(fake);
    expect(wrapper.find("[data-action='upload']").attributes("disabled")).toBeDefined();
    await addFiles(wrapper, [file("takeout-001.tgz", "abc"), file("subscriptions.csv", "a")]);
    expect(wrapper.find("[data-test='takeout-files']").text()).toContain("takeout-001.tgz");
    wrapper.findComponent(Select).vm.$emit("update:modelValue", 2);
    await flush();

    await wrapper.find("[data-action='upload']").trigger("click");
    await flush();
    const xhr = FakeXhr.last();
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/takeout?account_id=2");
    expect(xhr.body?.getAll("files").map((entry) => (entry as File).name)).toEqual([
      "takeout-001.tgz",
      "subscriptions.csv",
    ]);

    xhr.progress(25, 100);
    await flush();
    expect(wrapper.find("[data-test='takeout-uploading']").text()).toContain("Uploading 25%");

    xhr.respond(202, preview());
    await flush();
    const rows = wrapper.findAll("[data-test='preview-file']");
    expect(rows.map((row) => row.attributes("data-kind"))).toEqual([
      "history",
      "watch_later",
      "playlist:Mix",
    ]);
    expect(rows[0]?.text()).toContain("1,234");
    expect(rows[0]?.text()).toContain("3 ads, 2 removed or private videos");
    expect(rows[2]?.text()).toContain('Playlist "Mix" (counted, not imported)');
    expect(wrapper.find("[data-test='preview-skipped']").text()).toContain(
      "Not part of the import",
    );
    expect(wrapper.find("[data-test='preview-more']").text()).toContain("2 more files");
    expect(wrapper.find("[data-test='takeout-progress']").text()).toContain("Importing 0%");

    emit("job.progress", { id: 99, pct: 80 });
    emit("job.progress", { id: 7, pct: 40, message: "Imported 40 of 100" });
    await flush();
    expect(wrapper.find("[data-test='takeout-progress']").text()).toContain(
      "Importing 40%: Imported 40 of 100",
    );

    fake.on("GET /api/takeout/7", () => jobResponse({ status: "done", counts: counts() }));
    const activityCalls = fake.callsTo("GET /api/activity").length;
    emit("job.done", { id: 7 });
    await flush();
    expect(wrapper.find("[data-test='takeout-done']").exists()).toBe(true);
    expect(wrapper.find("[data-count='history']").text()).toBe("1,234 (900 videos)");
    expect(wrapper.find("[data-count='new_videos']").text()).toBe("800");
    expect(wrapper.find("[data-count='playlists_ignored']").text()).toBe("1 (4 videos)");
    expect(wrapper.find("[data-count='skipped']").text()).toBe(
      "3 ads, 2 removed or private videos",
    );
    expect(fake.callsTo("GET /api/activity").length).toBe(activityCalls + 1);
    expect(fake.callsTo("GET /api/activity")[0]?.query.get("kind")).toBe("takeout.imported");

    await wrapper.find("[data-action='reset']").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='takeout-result']").exists()).toBe(false);
    expect(wrapper.find("[data-test='takeout-drop']").exists()).toBe(true);
  });

  it("polls the job while it runs, in case an SSE frame is missed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fake = server();
    const wrapper = await mountPage(fake);
    (await uploadTo(wrapper)).respond(202, preview());
    await flush();
    expect(fake.callsTo("GET /api/takeout/7")).toHaveLength(1);
    fake.on("GET /api/takeout/7", () =>
      jobResponse({ status: "failed", error: "Account 1 does not exist." }),
    );
    vi.advanceTimersByTime(3000);
    await flush();
    expect(fake.callsTo("GET /api/takeout/7")).toHaveLength(2);
    expect(wrapper.find("[data-test='takeout-failed']").text()).toContain(
      "The import failed. Account 1 does not exist.",
    );
    vi.advanceTimersByTime(9000);
    await flush();
    expect(fake.callsTo("GET /api/takeout/7")).toHaveLength(2);
  });

  it("says when the job was cancelled", async () => {
    const fake = server();
    const wrapper = await mountPage(fake);
    (await uploadTo(wrapper)).respond(202, preview());
    await flush();
    fake.on("GET /api/takeout/7", () => jobResponse({ status: "cancelled" }));
    emit("job.cancelled", { id: 7 });
    await flush();
    expect(wrapper.find("[data-test='takeout-failed']").text()).toContain("was cancelled");
  });

  it("shows the server's message for a rejected upload (HTML history)", async () => {
    const wrapper = await mountPage(server());
    const xhr = await uploadTo(wrapper);
    xhr.respond(400, {
      error: "Your watch history was exported as HTML. Set history to JSON and export again.",
      code: "history_is_html",
    });
    await flush();
    expect(wrapper.find("[data-test='takeout-error']").text()).toContain("exported as HTML");
    expect(wrapper.find("[data-test='takeout-result']").exists()).toBe(false);
    expect(wrapper.find("[data-action='upload']").attributes("disabled")).toBeUndefined();
  });

  it("explains network failures and stays quiet on a cancelled upload", async () => {
    const wrapper = await mountPage(server());
    (await uploadTo(wrapper)).fail();
    await flush();
    expect(wrapper.find("[data-test='takeout-error']").text()).toBe("Could not reach the server.");

    await wrapper.find("[data-action='upload']").trigger("click");
    await flush();
    await wrapper.find("[data-action='cancel-upload']").trigger("click");
    await flush();
    expect(FakeXhr.last().aborted).toBe(true);
    expect(wrapper.find("[data-test='takeout-error']").exists()).toBe(false);
    expect(wrapper.find("[data-test='takeout-uploading']").exists()).toBe(false);
  });

  it("maps an error without a JSON body to the HTTP message", async () => {
    const wrapper = await mountPage(server());
    (await uploadTo(wrapper)).respond(413, "<html>too big</html>", "Payload Too Large");
    await flush();
    expect(wrapper.find("[data-test='takeout-error']").text()).toBe("That upload is too large.");
  });

  it("refuses an unreadable success body", async () => {
    const wrapper = await mountPage(server());
    (await uploadTo(wrapper)).respond(202, { job_id: "nope" });
    await flush();
    expect(wrapper.find("[data-test='takeout-error']").text()).toContain("could not read");
  });

  it("blocks uploads over 2 GB, dedupes and removes files", async () => {
    const wrapper = await mountPage(server());
    const huge = file("takeout-001.tgz");
    Object.defineProperty(huge, "size", { value: 3 * 1024 ** 3 });
    await addFiles(wrapper, [huge, huge]);
    expect(wrapper.findAll("[data-test='takeout-files'] li")).toHaveLength(1);
    expect(wrapper.find("[data-test='takeout-too-large']").text()).toContain("3.00 GB");
    expect(wrapper.find("[data-action='upload']").attributes("disabled")).toBeDefined();
    await wrapper.find("[data-action='remove-file']").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='takeout-files']").exists()).toBe(false);
  });

  it("names the files the drop zone ignored", async () => {
    const wrapper = await mountPage(server());
    wrapper.findComponent(TakeoutDropZone).vm.$emit("rejected", ["notes.txt"]);
    await flush();
    expect(wrapper.find("[data-test='takeout-rejected']").text()).toContain("notes.txt");
  });
});

describe("TakeoutDropZone", () => {
  function setFiles(input: HTMLInputElement, files: File[]): void {
    Object.defineProperty(input, "files", { value: files, configurable: true });
  }

  it("splits picked files into accepted and rejected", async () => {
    const wrapper = mount(TakeoutDropZone, { global: mountGlobals({ pinia }) });
    const input = wrapper.find("[data-test='takeout-file']");
    expect(input.attributes("accept")).toBe(".tgz,.tar.gz,.zip,.json,.csv");
    expect(input.attributes("multiple")).toBeDefined();
    setFiles(input.element as HTMLInputElement, [
      file("takeout-001.TGZ"),
      file("takeout-002.tar.gz"),
      file("watch-history.json"),
      file("notes.txt"),
    ]);
    await input.trigger("change");
    expect(wrapper.emitted("add")?.[0]?.[0]).toHaveLength(3);
    expect(wrapper.emitted("rejected")?.[0]).toEqual([["notes.txt"]]);
  });

  it("takes dropped files unless disabled", async () => {
    const wrapper = mount(TakeoutDropZone, { global: mountGlobals({ pinia }) });
    const zone = wrapper.find("[data-test='takeout-drop']");
    await zone.trigger("dragover", { dataTransfer: { dropEffect: "none", files: [] } });
    expect(zone.classes()).toContain("takeout-drop--active");
    await zone.trigger("drop", { dataTransfer: { files: [file("Liked videos-videos.csv")] } });
    expect(zone.classes()).not.toContain("takeout-drop--active");
    expect(wrapper.emitted("add")).toHaveLength(1);

    await wrapper.setProps({ disabled: true });
    await zone.trigger("dragover", { dataTransfer: null });
    await zone.trigger("drop", { dataTransfer: { files: [file("a.csv")] } });
    expect(wrapper.emitted("add")).toHaveLength(1);
  });
});

describe("TakeoutHistory", () => {
  it("lists previous imports and expands their counts", async () => {
    const fake = server({
      "GET /api/activity": () => ({
        rows: [importActivity(2), importActivity(1, { data: { not: "counts" } })],
        total: 2,
        page: 1,
        perPage: 20,
      }),
    });
    const wrapper = mount(TakeoutHistory, { global: mountGlobals({ api: fake.api, pinia }) });
    await flush();
    const entries = wrapper.findAll("[data-test='import-entry']");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.text()).toContain("Takeout imported: import 2");
    expect(entries[0]?.text()).toContain("1 h ago");
    expect(entries[1]?.find("[data-action='toggle-counts']").exists()).toBe(false);
    await entries[0]?.find("[data-action='toggle-counts']").trigger("click");
    expect(wrapper.find("[data-count='subscriptions']").text()).toBe("55");
    await entries[0]?.find("[data-action='toggle-counts']").trigger("click");
    expect(wrapper.find("[data-test='takeout-counts']").exists()).toBe(false);
  });

  it("says when there are none, reloads on a new import, and shows errors", async () => {
    const fake = server();
    const wrapper = mount(TakeoutHistory, { global: mountGlobals({ api: fake.api, pinia }) });
    await flush();
    expect(wrapper.find("[data-test='no-imports']").exists()).toBe(true);
    emit("activity", { kind: "download.done" });
    emit("job.done", { id: 1 });
    await flush();
    expect(fake.callsTo("GET /api/activity")).toHaveLength(1);
    fake.on("GET /api/activity", () => apiError(500, "internal error"));
    emit("activity", { kind: "takeout.imported" });
    await flush();
    expect(fake.callsTo("GET /api/activity")).toHaveLength(2);
    expect(wrapper.find(".error-state").text()).toContain("Could not load previous imports");
  });

  it("renders counts without optional rows", async () => {
    const fake = server({
      "GET /api/activity": () => ({
        rows: [
          importActivity(3, {
            data: counts({ playlists_ignored: 0, skipped: {}, recheck_jobs: null }),
          }),
        ],
        total: 1,
        page: 1,
        perPage: 20,
      }),
    });
    const wrapper = mount(TakeoutHistory, { global: mountGlobals({ api: fake.api, pinia }) });
    await flush();
    await wrapper.find("[data-action='toggle-counts']").trigger("click");
    expect(wrapper.find("[data-count='playlists_ignored']").exists()).toBe(false);
    expect(wrapper.find("[data-count='skipped']").exists()).toBe(false);
    expect(wrapper.find("[data-count='recheck']").text()).toBe("waiting for the recheck job");
  });
});
