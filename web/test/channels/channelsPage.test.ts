import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import DataTable from "primevue/datatable";
import SelectButton from "primevue/selectbutton";
import type { ChannelRow } from "@cellar/shared";
import ChannelsPage from "../../src/pages/ChannelsPage.vue";
import { describeChannelRef, needsResolve } from "../../src/api/channels.ts";
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

const UC = "UC0123456789abcdefghijkl";
const UC2 = "UCzyxwvutsrqponmlkjihgfe";

function channel(overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: UC,
    title: "Tech Channel",
    handle: "techchannel",
    thumbnail_url: "https://yt3.example/a.jpg",
    subscribed: true,
    manual: false,
    video_count: 1234,
    ...overrides,
  };
}

function page(rows: ChannelRow[], total = rows.length, call?: RecordedCall) {
  return {
    rows,
    total,
    page: Number(call?.query.get("page") ?? 1),
    perPage: Number(call?.query.get("perPage") ?? 25),
  };
}

let toasts: CapturedToast[];

beforeEach(() => {
  toasts = captureToasts();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function mountPage(server: FakeServer): Promise<VueWrapper> {
  const wrapper = mount(ChannelsPage, { global: mountGlobals({ api: server.api }) });
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
  const calls = server.callsTo("GET /api/channels");
  return calls[calls.length - 1]!;
}

describe("ChannelsPage list", () => {
  it("loads the first page and renders each channel", async () => {
    const server = fakeServer({
      "GET /api/channels": (call) =>
        page(
          [
            channel(),
            channel({
              id: UC2,
              title: null,
              handle: "@manualone",
              thumbnail_url: null,
              subscribed: false,
              manual: true,
              video_count: 0,
            }),
          ],
          2,
          call,
        ),
    });
    const wrapper = await mountPage(server);
    const call = lastList(server);
    expect(call.query.get("page")).toBe("1");
    expect(call.query.get("perPage")).toBe("25");
    expect(call.query.has("kind")).toBe(false);
    expect(call.query.has("q")).toBe(false);

    const rows = wrapper.findAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.find("img").attributes("src")).toBe("https://yt3.example/a.jpg");
    const link = rows[0]!.find(`[data-channel='${UC}']`);
    expect(link.text()).toBe("Tech Channel");
    expect(link.attributes("href")).toBe(`https://www.youtube.com/channel/${UC}`);
    expect(rows[0]!.find("[data-test='handle']").text()).toBe("@techchannel");
    expect(rows[0]!.text()).toContain("1,234");
    expect(rows[0]!.text()).toContain("Subscribed");
    expect(rows[0]!.find("[data-action='remove-channel']").exists()).toBe(false);

    expect(rows[1]!.find("img").exists()).toBe(false);
    expect(rows[1]!.find(`[data-channel='${UC2}']`).text()).toBe("@manualone");
    expect(rows[1]!.find("[data-test='handle']").text()).toBe("@manualone");
    expect(rows[1]!.text()).toContain("Manual");
    expect(rows[1]!.find("[data-action='remove-channel']").exists()).toBe(true);
    expect(wrapper.find("[data-test='channel-total']").text()).toBe("2 channels");
  });

  it("shows the empty state when there are no channels at all", async () => {
    const server = fakeServer({ "GET /api/channels": () => page([]) });
    const wrapper = await mountPage(server);
    expect(wrapper.find(".empty-state h2").text()).toBe("No channels yet");
    expect(wrapper.find("table").exists()).toBe(false);
  });

  it("shows an error state and retries", async () => {
    let calls = 0;
    const server = fakeServer({
      "GET /api/channels": () => {
        calls += 1;
        return calls === 1 ? apiError(503, "starting up") : page([channel()]);
      },
    });
    const wrapper = await mountPage(server);
    expect(wrapper.find(".error-state h2").text()).toBe("Could not load channels");
    await wrapper.find(".error-state button").trigger("click");
    await flush();
    expect(wrapper.findAll("tbody tr")).toHaveLength(1);
  });

  it("pages on the server with the chosen page size", async () => {
    const server = fakeServer({
      "GET /api/channels": (call) => page([channel()], 230, call),
    });
    const wrapper = await mountPage(server);
    wrapper.findComponent(DataTable).vm.$emit("page", { page: 2, rows: 50, first: 100 });
    await flush();
    const call = lastList(server);
    expect(call.query.get("page")).toBe("3");
    expect(call.query.get("perPage")).toBe("50");
  });

  it("searches on Enter and resets to the first page", async () => {
    const server = fakeServer({
      "GET /api/channels": (call) => page([channel()], 100, call),
    });
    const wrapper = await mountPage(server);
    wrapper.findComponent(DataTable).vm.$emit("page", { page: 1, rows: 25, first: 25 });
    await flush();
    const search = wrapper.find("[data-test='channel-search']");
    await search.setValue("  tech ");
    await search.trigger("keyup", { key: "Enter" });
    await flush();
    const call = lastList(server);
    expect(call.query.get("q")).toBe("tech");
    expect(call.query.get("page")).toBe("1");
  });

  it("debounces typing into one request", async () => {
    const server = fakeServer({ "GET /api/channels": () => page([channel()]) });
    const wrapper = await mountPage(server);
    const before = server.callsTo("GET /api/channels").length;
    const search = wrapper.find("[data-test='channel-search']");
    await search.setValue("t");
    await search.setValue("te");
    await search.setValue("tec");
    await new Promise((resolve) => setTimeout(resolve, 350));
    await flush();
    const after = server.callsTo("GET /api/channels");
    expect(after.length - before).toBe(1);
    expect(after[after.length - 1]!.query.get("q")).toBe("tec");
  });

  it("filters by kind, and clears filters from the no-match state", async () => {
    const server = fakeServer({
      "GET /api/channels": (call) =>
        call.query.get("kind") === "manual" ? page([]) : page([channel()]),
    });
    const wrapper = await mountPage(server);
    wrapper.findComponent(SelectButton).vm.$emit("update:modelValue", "manual");
    await flush();
    expect(lastList(server).query.get("kind")).toBe("manual");
    expect(wrapper.find("[data-test='no-matches']").exists()).toBe(true);
    expect(wrapper.find(".empty-state").exists()).toBe(false);
    await wrapper.find("[data-test='no-matches'] button").trigger("click");
    await flush();
    expect(lastList(server).query.has("kind")).toBe(false);
    expect(wrapper.findAll("tbody tr")).toHaveLength(1);
  });
});

describe("Add channel dialog", () => {
  async function openAdd(server: FakeServer) {
    const wrapper = await mountPage(server);
    await wrapper.find("[data-action='add-channel']").trigger("click");
    await flush();
    return wrapper;
  }

  it("pre-validates and names the parsed kind", async () => {
    const server = fakeServer({ "GET /api/channels": () => page([channel()]) });
    const wrapper = await openAdd(server);
    const input = wrapper.find("#channel-ref");
    const submit = () => wrapper.find("[data-action='add-channel-submit']");
    expect(submit().attributes("disabled")).toBeDefined();
    expect(wrapper.find("[data-test='ref-invalid']").exists()).toBe(false);

    await input.setValue("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(wrapper.find("[data-test='ref-invalid']").exists()).toBe(true);
    expect(submit().attributes("disabled")).toBeDefined();

    await input.setValue("https://www.youtube.com/@SomeHandle/videos");
    expect(wrapper.find("[data-test='ref-kind']").text()).toContain("Handle:");
    expect(wrapper.find("[data-test='ref-kind'] code").text()).toBe("@SomeHandle");
    expect(wrapper.find("[data-test='ref-kind']").text()).toContain("linked account");
    expect(submit().attributes("disabled")).toBeUndefined();

    await input.setValue(UC);
    expect(wrapper.find("[data-test='ref-kind']").text()).toContain("Channel id:");
    expect(wrapper.find("[data-test='ref-kind']").text()).not.toContain("linked account");
  });

  it("adds a channel, toasts and reloads the list", async () => {
    const server = fakeServer({
      "GET /api/channels": () => page([channel()]),
      "POST /api/channels": () => channel({ id: UC2, title: "New", manual: true }),
    });
    const wrapper = await openAdd(server);
    const before = server.callsTo("GET /api/channels").length;
    await wrapper.find("#channel-ref").setValue(`  ${UC2} `);
    await wrapper.find("[data-action='add-channel-submit']").trigger("click");
    await flush();
    expect(server.callsTo("POST /api/channels")[0]!.body).toEqual({ ref: UC2 });
    expect(toasts).toContainEqual(
      expect.objectContaining({ severity: "success", summary: "Channel added", detail: "New" }),
    );
    expect(server.callsTo("GET /api/channels").length).toBe(before + 1);
    expect(wrapper.find("#channel-ref").exists()).toBe(false);
  });

  it("explains the no_account conflict inline", async () => {
    const server = fakeServer({
      "GET /api/channels": () => page([channel()]),
      "POST /api/channels": () => apiError(409, "No linked account", "no_account"),
    });
    const wrapper = await openAdd(server);
    await wrapper.find("#channel-ref").setValue("@someone");
    await wrapper.find("[data-action='add-channel-submit']").trigger("click");
    await flush();
    const note = wrapper.find("[data-test='no-account']");
    expect(note.text()).toContain("No linked account could resolve this reference");
    expect(note.find("a").attributes("href")).toBe("/accounts");
    expect(wrapper.find("[data-test='add-error']").exists()).toBe(false);
    expect(wrapper.find("#channel-ref").exists()).toBe(true);
    await wrapper.find("#channel-ref").setValue(UC);
    expect(wrapper.find("[data-test='no-account']").exists()).toBe(false);
  });

  it("shows any other failure as an error", async () => {
    const server = fakeServer({
      "GET /api/channels": () => page([channel()]),
      "POST /api/channels": () => apiError(409, "Channel already tracked", "conflict"),
    });
    const wrapper = await openAdd(server);
    await wrapper.find("#channel-ref").setValue(UC);
    await wrapper.find("[data-action='add-channel-submit']").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='add-error']").text()).toBe("Channel already tracked");
  });

  it("closes on cancel", async () => {
    const server = fakeServer({ "GET /api/channels": () => page([channel()]) });
    const wrapper = await openAdd(server);
    await dialogButton(wrapper, "Cancel").trigger("click");
    await flush();
    expect(wrapper.find("#channel-ref").exists()).toBe(false);
  });
});

describe("Removing a manual channel", () => {
  const manual = () => channel({ id: UC2, title: "Hand picked", manual: true, subscribed: false });

  it("deletes after confirmation and reloads", async () => {
    const server = fakeServer({
      "GET /api/channels": () => page([manual()]),
      [`DELETE /api/channels/${UC2}`]: () => noContent(),
    });
    const wrapper = await mountPage(server);
    await wrapper.find("[data-action='remove-channel']").trigger("click");
    await flush();
    expect(wrapper.find(".confirm-message").text()).toContain("Remove Hand picked");
    const before = server.callsTo("GET /api/channels").length;
    await dialogButton(wrapper, "Remove").trigger("click");
    await flush();
    expect(server.callsTo(`DELETE /api/channels/${UC2}`)).toHaveLength(1);
    expect(server.callsTo("GET /api/channels").length).toBe(before + 1);
    expect(toasts).toContainEqual(expect.objectContaining({ summary: "Channel removed" }));
  });

  it("toasts the server's 409 message", async () => {
    const server = fakeServer({
      "GET /api/channels": () => page([manual()]),
      [`DELETE /api/channels/${UC2}`]: () =>
        apiError(409, "Only manually added channels can be removed", "not_manual"),
    });
    const wrapper = await mountPage(server);
    await wrapper.find("[data-action='remove-channel']").trigger("click");
    await flush();
    await dialogButton(wrapper, "Remove").trigger("click");
    await flush();
    expect(toasts).toContainEqual(
      expect.objectContaining({
        severity: "error",
        detail: "Only manually added channels can be removed",
      }),
    );
    await dialogButton(wrapper, "Cancel").trigger("click");
    await flush();
    expect(wrapper.find(".confirm-message").exists()).toBe(false);
  });
});

describe("channel ref helpers", () => {
  it("describes every kind", () => {
    expect(describeChannelRef({ kind: "url-custom", value: "name" })).toEqual({
      kind: "Custom URL",
      detail: "/c/name",
    });
    expect(describeChannelRef({ kind: "user", value: "old" })).toEqual({
      kind: "Legacy username",
      detail: "/user/old",
    });
    expect(needsResolve({ kind: "id", value: UC })).toBe(false);
    expect(needsResolve({ kind: "user", value: "old" })).toBe(true);
  });
});
