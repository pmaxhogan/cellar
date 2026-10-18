import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import App from "../src/App.vue";
import InsecureBanner from "../src/components/InsecureBanner.vue";
import type { ApiClient } from "../src/api/client.ts";
import { NAV_LINKS, routes } from "../src/router/index.ts";
import { useEventsStore } from "../src/stores/events.ts";
import { STATUS_REFRESH_DEBOUNCE_MS } from "../src/stores/status.ts";
import { flush } from "./helpers/dom.ts";
import { FakeEventSource } from "./helpers/eventSource.ts";
import { mountGlobals } from "./helpers/mount.ts";
import { makeStatus, stubApi } from "./helpers/stubApi.ts";

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mountApp(options: { path?: string; api?: ApiClient } = {}) {
  const api = options.api ?? stubApi();
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(options.path ?? "/");
  await router.isReady();
  const wrapper = mount(App, { global: mountGlobals({ api, router, pinia }) });
  // flush() waits on a real setTimeout, which never fires under fake timers.
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await flush();
  return { wrapper, router, api, pinia };
}

describe("App shell", () => {
  it("renders the wordmark in the sidebar", async () => {
    const { wrapper } = await mountApp();
    expect(wrapper.find(".cellar-brand").text()).toContain("Cellar");
    expect(wrapper.find(".cellar-brand img").attributes("src")).toBe("/favicon.svg");
  });

  it("renders one nav link per registered page, in order", async () => {
    const { wrapper } = await mountApp();
    const links = wrapper.findAll(".cellar-nav a");
    expect(links.map((link) => link.text())).toEqual(NAV_LINKS.map((link) => link.label));
    expect(links.map((link) => link.attributes("href"))).toEqual(NAV_LINKS.map((l) => l.to));
  });

  it("renders the Videos page at the default route", async () => {
    const { wrapper } = await mountApp();
    expect(wrapper.find(".cellar-main h1").text()).toBe("Videos");
  });

  it("swaps the routed view when navigating", async () => {
    const { wrapper, router } = await mountApp();
    await router.push("/shares");
    await flush();
    expect(wrapper.find(".cellar-main h1").text()).toBe("Share links");
  });

  it("has a status pill and a theme toggle in the sidebar footer", async () => {
    const { wrapper } = await mountApp();
    const footer = wrapper.find(".cellar-sidebar__footer");
    expect(footer.find(".status-pill").text()).toContain("ready");
    expect(footer.find(".theme-toggle").exists()).toBe(true);
  });

  it("loads the status and opens one event stream on mount", async () => {
    const { api } = await mountApp();
    expect(api.status).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.latest().url).toBe("/api/events");
  });

  it("refreshes the status after a burst of events, once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const api = stubApi();
    await mountApp({ api });
    const source = FakeEventSource.latest();
    source.open();
    source.message(JSON.stringify({ type: "job.done", at: 1, payload: {} }));
    source.message(JSON.stringify({ type: "job.done", at: 2, payload: {} }));
    expect(api.status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_DEBOUNCE_MS);
    expect(api.status).toHaveBeenCalledTimes(2);
  });

  it("polls the status once a minute", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const api = stubApi();
    await mountApp({ api });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.status).toHaveBeenCalledTimes(2);
  });

  it("closes the stream and stops polling on unmount", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const api = stubApi();
    const { wrapper } = await mountApp({ api });
    const source = FakeEventSource.latest();
    wrapper.unmount();
    expect(source.closed).toBe(true);
    expect(useEventsStore().state).toBe("closed");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.status).toHaveBeenCalledTimes(1);
  });
});

describe("insecure mode banner", () => {
  it("is absent when authentication is enforced", async () => {
    const { wrapper } = await mountApp();
    expect(wrapper.findComponent(InsecureBanner).exists()).toBe(false);
  });

  it("is absent while the status is still loading or unavailable", async () => {
    const api = stubApi({ status: vi.fn().mockRejectedValue(new Error("down")) });
    const { wrapper } = await mountApp({ api });
    expect(wrapper.findComponent(InsecureBanner).exists()).toBe(false);
  });

  it("appears at the very top when the server reports insecure mode", async () => {
    const api = stubApi({ status: vi.fn().mockResolvedValue(makeStatus({ insecureMode: true })) });
    const { wrapper } = await mountApp({ api });
    const banner = wrapper.findComponent(InsecureBanner);
    expect(banner.exists()).toBe(true);
    // First child of the shell: nothing renders above it.
    expect(wrapper.find(".cellar-shell").element.firstElementChild).toBe(banner.element);
  });

  it("carries the exact wording", async () => {
    const wrapper = mount(InsecureBanner);
    expect(wrapper.text()).toContain("INSECURE MODE: authentication is disabled.");
    expect(wrapper.text()).toContain("This instance trusts all local traffic.");
  });

  it("is announced as an alert and offers no way to dismiss it", () => {
    const wrapper = mount(InsecureBanner);
    expect(wrapper.attributes("role")).toBe("alert");
    expect(wrapper.attributes("aria-live")).toBe("assertive");
    expect(wrapper.findAll("button")).toHaveLength(0);
  });
});
