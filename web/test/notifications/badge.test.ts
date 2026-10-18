import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import App from "../../src/App.vue";
import { routes } from "../../src/router/index.ts";
import { useEventsStore } from "../../src/stores/events.ts";
import { useNotificationsStore } from "../../src/stores/notifications.ts";
import { flush } from "../helpers/dom.ts";
import { FakeEventSource } from "../helpers/eventSource.ts";
import { apiError, fakeServer, json } from "../helpers/fakeServer.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { makeStatus } from "../helpers/stubApi.ts";
import { paged } from "./fixtures.ts";

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function server(unread: number) {
  // Last registered wins, so the catch-all goes first.
  return fakeServer()
    .on("GET", /.*/, () => json(paged([])))
    .on("GET", "/api/status", () => json(makeStatus()))
    .on("GET", "/api/notifications", () => json(paged([], unread, 1, 1)));
}

async function mountApp(fake = server(0)) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push("/about");
  await router.isReady();
  const wrapper = mount(App, { global: mountGlobals({ api: fake.api, router, pinia }) });
  await flush();
  return { wrapper, fake };
}

describe("unread badge", () => {
  it("shows the unread count next to Notifications, from an unacked count query", async () => {
    const { wrapper, fake } = await mountApp(server(3));
    const request = fake.callsTo("GET", "/api/notifications")[0]!;
    expect(request.query.get("unacked")).toBe("1");
    expect(request.query.get("perPage")).toBe("1");
    const link = wrapper.find(".cellar-nav a[href='/notifications']");
    expect(link.find("[data-unread-badge]").text()).toBe("3 unread");
    expect(wrapper.findAll("[data-unread-badge]")).toHaveLength(1);
  });

  it("is hidden at zero and counts live notification events", async () => {
    const { wrapper } = await mountApp();
    expect(wrapper.find("[data-unread-badge]").exists()).toBe(false);

    const source = FakeEventSource.latest();
    source.open();
    source.named("notification", JSON.stringify({ type: "notification", at: 1, payload: {} }));
    source.named("activity", JSON.stringify({ type: "activity", at: 1, payload: {} }));
    await flush();
    expect(wrapper.find("[data-unread-badge]").text()).toBe("1 unread");
  });

  it("caps the display at 99+", async () => {
    const { wrapper } = await mountApp(server(250));
    expect(wrapper.find("[data-unread-badge]").text()).toBe("99+ unread");
  });

  it("stops counting after the shell unmounts", async () => {
    const { wrapper } = await mountApp();
    const store = useNotificationsStore();
    const events = useEventsStore();
    wrapper.unmount();
    events.dispatch({ type: "notification", at: 1, payload: {} });
    expect(store.unread).toBe(0);
  });
});

describe("notifications store", () => {
  it("keeps the last count when the count request fails, and never goes negative", async () => {
    const store = useNotificationsStore();
    store.setUnread(2);
    const fake = fakeServer().on("GET", "/api/notifications", () => apiError(500, "down"));
    await store.load(fake.api);
    expect(store.unread).toBe(2);
    store.acknowledged(5);
    expect(store.unread).toBe(0);
    await store.load();
    expect(fake.calls).toHaveLength(2);
  });

  it("does nothing before it has a client", async () => {
    const store = useNotificationsStore();
    await store.load();
    expect(store.unread).toBe(0);
  });
});
