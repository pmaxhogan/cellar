import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import DataTable from "primevue/datatable";
import type { TitleChangeRow } from "@cellar/shared";
import TitleChangesPage from "../../src/pages/TitleChangesPage.vue";
import ChannelPicker from "../../src/components/rules/ChannelPicker.vue";
import { listTitleChanges } from "../../src/api/titleChanges.ts";
import { formatAbsolute } from "../../src/lib/format.ts";
import { flush } from "../helpers/dom.ts";
import { apiError, fakeServer, type FakeServer, type RecordedCall } from "../helpers/adminFetch.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { stubApi } from "../helpers/stubApi.ts";

const NOW = Date.now();
const ID = "dQw4w9WgXcQ";
const ID2 = "aaaaaaaaaaa";

function change(overrides: Partial<TitleChangeRow> = {}): TitleChangeRow {
  return {
    id: 1,
    video_id: ID,
    channel_id: "UCone",
    channel_title: "Wine Channel",
    title: "Newest title",
    old_title: "Old title",
    new_title: "Newest title",
    changed_at: NOW - 3_600_000,
    thumbnail_url: `/api/videos/${ID}/thumbnail/hqdefault?sha=h1`,
    ...overrides,
  };
}

function page(rows: TitleChangeRow[], total = rows.length, call?: RecordedCall) {
  return {
    rows,
    total,
    page: Number(call?.query.get("page") ?? 1),
    perPage: Number(call?.query.get("perPage") ?? 25),
  };
}

const two = () => [
  change(),
  change({
    id: 2,
    video_id: ID2,
    channel_id: null,
    channel_title: null,
    title: "Current",
    old_title: null,
    new_title: "Middle",
    thumbnail_url: null,
  }),
];

async function mountPage(server: FakeServer): Promise<VueWrapper> {
  const wrapper = mount(TitleChangesPage, { global: mountGlobals({ api: server.api }) });
  await flush();
  return wrapper;
}

function lastList(server: FakeServer): RecordedCall {
  const calls = server.callsTo("GET /api/title-changes");
  return calls[calls.length - 1]!;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("listTitleChanges", () => {
  it("sends paging and filters, dropping empty ones", async () => {
    const server = fakeServer({ "GET /api/title-changes": (call) => page([], 0, call) });
    await listTitleChanges(server.api, { page: 2, perPage: 50, channelId: "UCx", q: "  a b " });
    expect(Object.fromEntries(lastList(server).query)).toEqual({
      page: "2",
      perPage: "50",
      channel_id: "UCx",
      q: "a b",
    });
    await listTitleChanges(server.api, { page: 1, perPage: 25, channelId: null, q: "   " });
    expect(Object.fromEntries(lastList(server).query)).toEqual({ page: "1", perPage: "25" });
  });

  it("rejects a response that does not match the schema", async () => {
    const server = fakeServer({ "GET /api/title-changes": () => ({ rows: [{}], total: 1 }) });
    await expect(listTitleChanges(server.api, { page: 1, perPage: 25 })).rejects.toThrow();
  });
});

describe("TitleChangesPage", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("loads the first page and renders each change", async () => {
    const server = fakeServer({ "GET /api/title-changes": (call) => page(two(), 2, call) });
    const wrapper = await mountPage(server);
    expect(Object.fromEntries(lastList(server).query)).toEqual({ page: "1", perPage: "25" });
    expect(wrapper.find("h1").text()).toBe("Title changes");

    const rows = wrapper.findAll("tbody tr");
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(first.find("[data-test='old-title']").text()).toBe("Old title");
    expect(first.find("[data-test='arrow']").text()).toBe("->");
    const link = first.find(`[data-video='${ID}']`);
    expect(link.text()).toBe("Newest title");
    expect(link.attributes("href")).toBe(`/videos/${ID}`);
    expect(first.find("[data-test='channel']").text()).toBe("Wine Channel");
    expect(first.find("img").attributes("src")).toBe(
      `/api/videos/${ID}/thumbnail/hqdefault?sha=h1`,
    );
    const when = first.find("[data-test='changed-at']");
    expect(when.text()).toBe("1 h ago");
    expect(when.attributes("title")).toBe(formatAbsolute(NOW - 3_600_000));
    // The current title only shows when it differs from the new one.
    expect(first.find("[data-test='current-title']").exists()).toBe(false);

    const second = rows[1]!;
    expect(second.find("[data-test='old-title']").text()).toBe("(no title)");
    expect(second.find("[data-test='channel']").text()).toBe("-");
    expect(second.find("[data-test='current-title']").text()).toBe("Now: Current");
    expect(second.find("img").exists()).toBe(false);
    expect(wrapper.find("[data-test='title-changes-total']").text()).toBe("2 title changes");
  });

  it("searches on enter and after a pause, back on page 1", async () => {
    const server = fakeServer({ "GET /api/title-changes": (call) => page(two(), 60, call) });
    const wrapper = await mountPage(server);
    wrapper.findComponent(DataTable).vm.$emit("page", { page: 1, rows: 25 });
    await flush();
    expect(lastList(server).query.get("page")).toBe("2");

    const input = wrapper.find("[data-test='title-search']");
    await input.setValue("cat");
    await input.trigger("keyup.enter");
    await flush();
    expect(Object.fromEntries(lastList(server).query)).toEqual({
      page: "1",
      perPage: "25",
      q: "cat",
    });

    vi.useFakeTimers();
    const before = server.callsTo("GET /api/title-changes").length;
    await input.setValue("dog");
    vi.advanceTimersByTime(299);
    expect(server.callsTo("GET /api/title-changes")).toHaveLength(before);
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    await flush();
    expect(lastList(server).query.get("q")).toBe("dog");
  });

  it("filters by channel and clears the filters", async () => {
    const server = fakeServer({ "GET /api/title-changes": (call) => page(two(), 2, call) });
    const wrapper = await mountPage(server);
    expect(wrapper.find("[data-test='title-changes-reset']").exists()).toBe(false);
    wrapper.findComponent(ChannelPicker).vm.$emit("update:modelValue", "UCone");
    await flush();
    expect(lastList(server).query.get("channel_id")).toBe("UCone");

    await wrapper.find("[data-test='title-changes-reset']").trigger("click");
    await flush();
    expect(Object.fromEntries(lastList(server).query)).toEqual({ page: "1", perPage: "25" });
  });

  it("changes the page size", async () => {
    const server = fakeServer({ "GET /api/title-changes": (call) => page(two(), 200, call) });
    const wrapper = await mountPage(server);
    wrapper.findComponent(DataTable).vm.$emit("page", { page: 0, rows: 100 });
    await flush();
    expect(Object.fromEntries(lastList(server).query)).toEqual({ page: "1", perPage: "100" });
  });

  it("shows the empty state when nothing has been renamed", async () => {
    const server = fakeServer({ "GET /api/title-changes": (call) => page([], 0, call) });
    const wrapper = await mountPage(server);
    expect(wrapper.find(".empty-state h2").text()).toBe("No title changes yet");
    expect(wrapper.find(".empty-state [data-icon='titles']").exists()).toBe(true);
    expect(wrapper.findComponent(DataTable).exists()).toBe(false);
  });

  it("offers to clear filters when nothing matches", async () => {
    const server = fakeServer({
      "GET /api/title-changes": (call) =>
        page(call.query.has("q") ? [] : two(), call.query.has("q") ? 0 : 2, call),
    });
    const wrapper = await mountPage(server);
    const input = wrapper.find("[data-test='title-search']");
    await input.setValue("nothing");
    await input.trigger("keyup.enter");
    await flush();
    const none = wrapper.find("[data-test='no-matches']");
    expect(none.text()).toContain("No title changes match these filters.");
    await none.find("button").trigger("click");
    await flush();
    expect(lastList(server).query.has("q")).toBe(false);
    expect(wrapper.findAll("tbody tr")).toHaveLength(2);
    // Clearing the box does not fire a second, debounced load.
    const after = server.callsTo("GET /api/title-changes").length;
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(server.callsTo("GET /api/title-changes")).toHaveLength(after);
  });

  it("shows an error state and retries", async () => {
    let calls = 0;
    const server = fakeServer({
      "GET /api/title-changes": (call) => {
        calls += 1;
        return calls === 1 ? apiError(503, "starting up") : page(two(), 2, call);
      },
    });
    const wrapper = await mountPage(server);
    expect(wrapper.find(".error-state").text()).toContain("Could not load title changes");
    await wrapper.find(".error-state button").trigger("click");
    await flush();
    expect(wrapper.find(".error-state").exists()).toBe(false);
    expect(wrapper.findAll("tbody tr")).toHaveLength(2);
  });

  it("aborts a load that a newer one replaces", async () => {
    const server = fakeServer({ "GET /api/title-changes": (call) => page(two(), 60, call) });
    const wrapper = await mountPage(server);
    wrapper.findComponent(DataTable).vm.$emit("page", { page: 1, rows: 25 });
    wrapper.findComponent(DataTable).vm.$emit("page", { page: 2, rows: 25 });
    await flush();
    const calls = server.callsTo("GET /api/title-changes");
    expect(calls[calls.length - 2]!.signal?.aborted).toBe(true);
    expect(lastList(server).query.get("page")).toBe("3");
    expect(wrapper.find(".error-state").exists()).toBe(false);
  });

  it("survives a client that answers nothing", async () => {
    const wrapper = mount(TitleChangesPage, { global: mountGlobals({ api: stubApi() }) });
    await flush();
    expect(wrapper.find(".error-state").exists()).toBe(true);
    wrapper.unmount();
  });
});
