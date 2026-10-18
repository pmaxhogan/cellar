import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import DataTable from "primevue/datatable";
import DatePicker from "primevue/datepicker";
import Select from "primevue/select";
import SelectButton from "primevue/selectbutton";
import type { ShareLinkRow } from "@cellar/shared";
import SharesPage from "../../src/pages/SharesPage.vue";
import CreateShareDialog from "../../src/components/shares/CreateShareDialog.vue";
import { copyText } from "../../src/components/shares/clipboard.ts";
import { expiryFor, revokeShares } from "../../src/api/shares.ts";
import { flush } from "../helpers/dom.ts";
import {
  apiError,
  captureToasts,
  fakeServer,
  noContent,
  type CapturedToast,
  type FakeServer,
  type RecordedCall,
} from "../helpers/adminFetch.ts";
import { mountGlobals } from "../helpers/mount.ts";

const T1 = "AAAAAAAAAAAAAAAAAAAAAA";
const T2 = "BBBBBBBBBBBBBBBBBBBBBB";
const NOW = Date.now();

function link(overrides: Partial<ShareLinkRow> = {}): ShareLinkRow {
  return {
    token: T1,
    video_id: "dQw4w9WgXcQ",
    title: "Cellar tour",
    channel_title: "Wine Channel",
    expires_at: null,
    revoked_at: null,
    access_count: 1234,
    last_access_at: null,
    created_at: NOW - 3_600_000,
    url: `https://cellar.example/s/${T1}`,
    status: "active",
    ...overrides,
  };
}

function page(rows: ShareLinkRow[], total = rows.length, call?: RecordedCall) {
  return {
    rows,
    total,
    page: Number(call?.query.get("page") ?? 1),
    perPage: Number(call?.query.get("perPage") ?? 25),
  };
}

let toasts: CapturedToast[];
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  toasts = captureToasts();
  writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...globalThis.navigator, clipboard: { writeText } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountPage(server: FakeServer): Promise<VueWrapper> {
  const wrapper = mount(SharesPage, { global: mountGlobals({ api: server.api }) });
  await flush();
  return wrapper;
}

function dialogButton(wrapper: VueWrapper, label: string) {
  const found = wrapper
    .findAll(".p-dialog button")
    .find((candidate) => candidate.text().trim() === label);
  if (found === undefined) throw new Error(`no dialog button labelled ${label}`);
  return found;
}

function lastList(server: FakeServer): RecordedCall {
  const calls = server.callsTo("GET /api/shares");
  return calls[calls.length - 1]!;
}

const two = () => [
  link(),
  link({
    token: T2,
    title: null,
    channel_title: null,
    expires_at: NOW - 2 * 86_400_000,
    status: "revoked",
    revoked_at: NOW - 500,
    last_access_at: NOW - 60_000,
    url: `https://cellar.example/s/${T2}`,
  }),
];

describe("SharesPage list", () => {
  it("loads the first page and renders each link", async () => {
    const server = fakeServer({ "GET /api/shares": (call) => page(two(), 2, call) });
    const wrapper = await mountPage(server);
    const call = lastList(server);
    expect(Object.fromEntries(call.query)).toEqual({
      page: "1",
      perPage: "25",
      sort: "created_at",
      dir: "desc",
    });

    const rows = wrapper.findAll("tbody tr");
    expect(rows).toHaveLength(2);
    const video = rows[0]!.find("[data-video='dQw4w9WgXcQ']");
    expect(video.text()).toBe("Cellar tour");
    expect(video.attributes("href")).toBe("/videos/dQw4w9WgXcQ");
    expect(rows[0]!.text()).toContain("Wine Channel");
    expect(rows[0]!.find("[data-test='token']").text()).toBe("AAAAAAAA...");
    expect(rows[0]!.find("[data-test='token']").attributes("title")).toBe(T1);
    const open = rows[0]!.find("[data-test='open-link']");
    expect(open.attributes("href")).toBe(`https://cellar.example/s/${T1}`);
    expect(open.attributes("target")).toBe("_blank");
    expect(open.attributes("rel")).toBe("noopener noreferrer");
    expect(rows[0]!.find("[data-test='expires']").text()).toBe("never");
    expect(rows[0]!.text()).toContain("1,234");
    expect(rows[0]!.text()).toContain("1 h ago");
    expect(rows[0]!.find("[data-test='status']").text()).toBe("Active");
    expect(rows[0]!.find("[data-action='revoke']").exists()).toBe(true);
    expect(rows[0]!.find("[data-action='delete']").exists()).toBe(false);

    expect(rows[1]!.find("[data-video='dQw4w9WgXcQ']").text()).toBe("dQw4w9WgXcQ");
    expect(rows[1]!.find("[data-test='expires']").text()).toContain("ago");
    expect(rows[1]!.find("[data-test='status']").text()).toBe("Revoked");
    expect(rows[1]!.find("[data-action='revoke']").exists()).toBe(false);
    expect(rows[1]!.find("[data-action='delete']").exists()).toBe(true);
    expect(wrapper.find("[data-test='share-total']").text()).toBe("2 links");
  });

  it("shows the empty state, then a no-matches row under a filter", async () => {
    const server = fakeServer({ "GET /api/shares": (call) => page([], 0, call) });
    const wrapper = await mountPage(server);
    expect(wrapper.find(".empty-state").text()).toContain("No share links");

    wrapper.findComponent(Select).vm.$emit("update:modelValue", "expired");
    await flush();
    expect(lastList(server).query.get("status")).toBe("expired");
    expect(wrapper.find("[data-test='no-matches']").exists()).toBe(true);
    await wrapper.find("[data-test='no-matches'] button").trigger("click");
    await flush();
    expect(lastList(server).query.has("status")).toBe(false);
  });

  it("searches (debounced and on enter), pages and sorts", async () => {
    vi.useFakeTimers();
    try {
      const server = fakeServer({ "GET /api/shares": (call) => page(two(), 120, call) });
      const wrapper = mount(SharesPage, { global: mountGlobals({ api: server.api }) });
      await vi.runAllTimersAsync();
      const input = wrapper.find("[data-test='share-search']");
      await input.setValue("tour");
      await vi.advanceTimersByTimeAsync(350);
      expect(lastList(server).query.get("q")).toBe("tour");
      await input.setValue("tou");
      await input.trigger("keyup.enter");
      await vi.runAllTimersAsync();
      expect(lastList(server).query.get("q")).toBe("tou");

      const table = wrapper.findComponent(DataTable);
      table.vm.$emit("page", { page: 2, rows: 50 });
      await vi.runAllTimersAsync();
      expect(lastList(server).query.get("page")).toBe("3");
      expect(lastList(server).query.get("perPage")).toBe("50");

      table.vm.$emit("sort", { sortField: "access_count", sortOrder: 1 });
      await vi.runAllTimersAsync();
      expect(lastList(server).query.get("sort")).toBe("access_count");
      expect(lastList(server).query.get("dir")).toBe("asc");
      expect(lastList(server).query.get("page")).toBe("1");

      table.vm.$emit("sort", { sortField: null, sortOrder: 0 });
      await vi.runAllTimersAsync();
      expect(lastList(server).query.get("sort")).toBe("created_at");
      expect(lastList(server).query.get("dir")).toBe("desc");
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an error with a retry", async () => {
    const server = fakeServer({ "GET /api/shares": () => apiError(500, "internal error") });
    const wrapper = await mountPage(server);
    expect(wrapper.find(".error-state").exists()).toBe(true);
    server.on("GET /api/shares", (call) => page(two(), 2, call));
    await wrapper.find(".error-state button").trigger("click");
    await flush();
    expect(wrapper.findAll("tbody tr")).toHaveLength(2);
  });
});

describe("SharesPage actions", () => {
  it("copies a link to the clipboard with a toast", async () => {
    const server = fakeServer({ "GET /api/shares": (call) => page(two(), 2, call) });
    const wrapper = await mountPage(server);
    await wrapper.find("[data-action='copy-link']").trigger("click");
    await flush();
    expect(writeText).toHaveBeenCalledWith(`https://cellar.example/s/${T1}`);
    expect(toasts.at(-1)).toMatchObject({ severity: "success", summary: "Link copied" });

    writeText.mockRejectedValueOnce(new Error("denied"));
    await wrapper.find("[data-action='copy-link']").trigger("click");
    await flush();
    expect(toasts.at(-1)).toMatchObject({ severity: "warn", summary: "Copy failed" });
  });

  it("revokes one link after confirmation", async () => {
    const server = fakeServer({
      "GET /api/shares": (call) => page(two(), 2, call),
      [`POST /api/shares/${T1}/revoke`]: () => link({ status: "revoked", revoked_at: NOW }),
    });
    const wrapper = await mountPage(server);
    await wrapper.find("[data-action='revoke']").trigger("click");
    await flush();
    expect(wrapper.find(".confirm-message").text()).toContain("Cellar tour");
    await dialogButton(wrapper, "Revoke").trigger("click");
    await flush();
    expect(server.callsTo(`POST /api/shares/${T1}/revoke`)).toHaveLength(1);
    expect(toasts.at(-1)).toMatchObject({ summary: "Link revoked" });
    expect(server.callsTo("GET /api/shares")).toHaveLength(2);
  });

  it("deletes a revoked link and reports a failure", async () => {
    const server = fakeServer({
      "GET /api/shares": (call) => page(two(), 2, call),
      [`DELETE /api/shares/${T2}`]: () => apiError(409, "Revoke the link before deleting it."),
    });
    const wrapper = await mountPage(server);
    await wrapper.find("[data-action='delete']").trigger("click");
    await flush();
    await dialogButton(wrapper, "Delete").trigger("click");
    await flush();
    expect(toasts.at(-1)).toMatchObject({ severity: "error" });
    expect(wrapper.find(".confirm-message").exists()).toBe(true);

    server.on(`DELETE /api/shares/${T2}`, () => noContent());
    await dialogButton(wrapper, "Delete").trigger("click");
    await flush();
    expect(toasts.at(-1)).toMatchObject({ summary: "Link deleted" });
    expect(wrapper.find(".confirm-message").exists()).toBe(false);
  });

  it("revokes the selected active links", async () => {
    const server = fakeServer({
      "GET /api/shares": (call) => page(two(), 2, call),
      "POST /api/shares/revoke": () => ({ count: 1 }),
    });
    const wrapper = await mountPage(server);
    const bulk = wrapper.find("[data-action='revoke-selected']");
    expect(bulk.attributes("disabled")).toBeDefined();
    wrapper.findComponent(DataTable).vm.$emit("update:selection", two());
    await flush();
    expect(bulk.text()).toBe("Revoke selected (1)");
    await bulk.trigger("click");
    await flush();
    expect(wrapper.find(".confirm-message").text()).toContain("1 selected link");
    await dialogButton(wrapper, "Revoke").trigger("click");
    await flush();
    expect(server.callsTo("POST /api/shares/revoke")[0]?.body).toEqual({ tokens: [T1] });
    expect(toasts.at(-1)).toMatchObject({ summary: "1 link revoked" });
  });

  it("revokes all links matching the filters", async () => {
    const server = fakeServer({
      "GET /api/shares": (call) => page(two(), 40, call),
      "POST /api/shares/revoke": () => ({ count: 39 }),
    });
    const wrapper = await mountPage(server);
    await wrapper.find("[data-test='share-search']").setValue("tour");
    await wrapper.find("[data-test='share-search']").trigger("keyup.enter");
    await flush();
    await wrapper.find("[data-action='revoke-all']").trigger("click");
    await flush();
    expect(wrapper.find(".confirm-message").text()).toContain("matching the current filters");
    expect(wrapper.find(".confirm-message").text()).toContain("40 links");
    await dialogButton(wrapper, "Revoke all").trigger("click");
    await flush();
    expect(server.callsTo("POST /api/shares/revoke")[0]?.body).toEqual({
      all_matching: { q: "tour" },
    });
    expect(toasts.at(-1)).toMatchObject({ summary: "39 links revoked" });
  });

  it("cancels a pending confirmation", async () => {
    const server = fakeServer({ "GET /api/shares": (call) => page(two(), 2, call) });
    const wrapper = await mountPage(server);
    await wrapper.find("[data-action='revoke-all']").trigger("click");
    await flush();
    expect(wrapper.find(".confirm-message").text()).toContain("in the list");
    await dialogButton(wrapper, "Cancel").trigger("click");
    await flush();
    expect(wrapper.find(".confirm-message").exists()).toBe(false);
    expect(server.callsTo("POST /api/shares/revoke")).toHaveLength(0);
  });
});

describe("creating a link", () => {
  it("creates from a URL with a preset, copies it and reloads", async () => {
    const created = link({ token: T2, url: `https://cellar.example/s/${T2}` });
    const server = fakeServer({
      "GET /api/shares": (call) => page([], 0, call),
      "POST /api/shares": () => created,
    });
    const wrapper = await mountPage(server);
    await wrapper.find("[data-action='create-share']").trigger("click");
    await flush();
    const submit = wrapper.find("[data-action='create-share-submit']");
    expect(submit.attributes("disabled")).toBeDefined();

    await wrapper.find("[data-test='share-video']").setValue("https://youtu.be/dQw4w9WgXcQ?t=5");
    expect(wrapper.find("[data-test='share-video-id']").text()).toContain("dQw4w9WgXcQ");
    wrapper.findComponent(SelectButton).vm.$emit("update:modelValue", "1d");
    await flush();
    const before = Date.now();
    await submit.trigger("click");
    await flush();

    const body = server.callsTo("POST /api/shares")[0]?.body as {
      video_id: string;
      expires_at: number;
    };
    expect(body.video_id).toBe("dQw4w9WgXcQ");
    expect(body.expires_at).toBeGreaterThanOrEqual(before + 86_400_000);
    expect(body.expires_at).toBeLessThan(before + 86_400_000 + 60_000);
    expect(writeText).toHaveBeenCalledWith(`https://cellar.example/s/${T2}`);
    expect(toasts.at(-1)).toMatchObject({
      summary: "Link created and copied",
      detail: `https://cellar.example/s/${T2}`,
    });
    expect(server.callsTo("GET /api/shares")).toHaveLength(2);
  });

  it("rejects a channel link and shows server errors", async () => {
    const server = fakeServer({
      "POST /api/shares": () => apiError(404, "Video dQw4w9WgXcQ does not exist.", "not_found"),
    });
    const wrapper = mount(CreateShareDialog, {
      props: { visible: true, videoId: "" },
      global: mountGlobals({ api: server.api }),
    });
    await flush();
    await wrapper.find("[data-test='share-video']").setValue("https://www.youtube.com/@handle");
    expect(wrapper.find("[data-test='share-video-invalid']").exists()).toBe(true);
    await wrapper.find("[data-test='share-video']").setValue("dQw4w9WgXcQ");
    wrapper.findComponent(SelectButton).vm.$emit("update:modelValue", "never");
    await flush();
    await wrapper.find("[data-action='create-share-submit']").trigger("click");
    await flush();
    expect(server.callsTo("POST /api/shares")[0]?.body).toEqual({
      video_id: "dQw4w9WgXcQ",
      expires_at: null,
    });
    expect(wrapper.find("[data-test='share-create-error']").text()).toContain("does not exist");
    expect(wrapper.emitted("created")).toBeUndefined();
  });

  it("needs a future custom date", async () => {
    const server = fakeServer({ "POST /api/shares": () => link() });
    const wrapper = mount(CreateShareDialog, {
      props: { visible: true, videoId: "dQw4w9WgXcQ" },
      global: mountGlobals({ api: server.api }),
    });
    await flush();
    wrapper.findComponent(SelectButton).vm.$emit("update:modelValue", "custom");
    await flush();
    const submit = wrapper.find("[data-action='create-share-submit']");
    expect(submit.attributes("disabled")).toBeDefined();
    wrapper.findComponent(DatePicker).vm.$emit("update:modelValue", new Date(Date.now() - 1000));
    await flush();
    expect(wrapper.find("[data-test='share-custom-invalid']").exists()).toBe(true);
    const at = new Date(Date.now() + 3 * 86_400_000);
    wrapper.findComponent(DatePicker).vm.$emit("update:modelValue", at);
    await flush();
    await submit.trigger("click");
    await flush();
    expect(server.callsTo("POST /api/shares")[0]?.body).toEqual({
      video_id: "dQw4w9WgXcQ",
      expires_at: at.getTime(),
    });
    expect(wrapper.emitted("created")).toHaveLength(1);
    expect(wrapper.emitted("update:visible")?.at(-1)).toEqual([false]);
  });

  it("toasts without the copy when the clipboard refuses", async () => {
    vi.stubGlobal("navigator", {});
    const server = fakeServer({
      "GET /api/shares": (call) => page([], 0, call),
      "POST /api/shares": () => link(),
    });
    const wrapper = await mountPage(server);
    await wrapper.find("[data-action='create-share']").trigger("click");
    await flush();
    await wrapper.find("[data-test='share-video']").setValue("dQw4w9WgXcQ");
    await wrapper.find("[data-action='create-share-submit']").trigger("click");
    await flush();
    expect(toasts.at(-1)).toMatchObject({ summary: "Link created" });
  });
});

describe("share helpers", () => {
  it("maps presets to expiries", () => {
    const now = 1_000_000;
    expect(expiryFor("1d", null, now)).toBe(now + 86_400_000);
    expect(expiryFor("7d", null, now)).toBe(now + 7 * 86_400_000);
    expect(expiryFor("30d", null, now)).toBe(now + 30 * 86_400_000);
    expect(expiryFor("never", null, now)).toBeNull();
    expect(expiryFor("custom", null, now)).toBeUndefined();
    expect(expiryFor("custom", new Date(now - 1), now)).toBeUndefined();
    expect(expiryFor("custom", new Date(now + 5), now)).toBe(now + 5);
  });

  it("drops empty filter fields from a bulk revoke", async () => {
    const server = fakeServer({ "POST /api/shares/revoke": () => ({ count: 0 }) });
    await revokeShares(server.api, { filter: { q: "", status: "active" } });
    expect(server.calls[0]?.body).toEqual({ all_matching: { status: "active" } });
  });

  it("copies text or reports failure", async () => {
    expect(await copyText("x")).toBe(true);
    vi.stubGlobal("navigator", {});
    expect(await copyText("x")).toBe(false);
  });
});
