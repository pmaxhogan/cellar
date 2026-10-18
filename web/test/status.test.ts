import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import StatusPill from "../src/components/StatusPill.vue";
import { ApiClientError } from "../src/api/client.ts";
import { useEventsStore } from "../src/stores/events.ts";
import { STATUS_REFRESH_DEBOUNCE_MS, useStatusStore } from "../src/stores/status.ts";
import { makeStatus, stubApi } from "./helpers/stubApi.ts";

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.useRealTimers();
});

const EVENT = { type: "job.done", at: 1, payload: null };

describe("status store", () => {
  it("starts out connecting, with nothing loaded", () => {
    const store = useStatusStore();
    expect(store.summary).toBe("connecting");
    expect(store.tone).toBe("idle");
    expect(store.insecureMode).toBe(false);
    expect(store.missingTools).toEqual([]);
  });

  it("does nothing on load before a client is known", async () => {
    const store = useStatusStore();
    await store.load();
    expect(store.loading).toBe(false);
    expect(store.status).toBeNull();
  });

  it("loads the status and reports ready", async () => {
    const store = useStatusStore();
    await store.load(stubApi());
    expect(store.status?.version).toBe("0.1.0-test");
    expect(store.summary).toBe("ready");
    expect(store.tone).toBe("idle");
    expect(store.loading).toBe(false);
  });

  it("reads insecure mode from the server", async () => {
    const store = useStatusStore();
    await store.load(
      stubApi({ status: vi.fn().mockResolvedValue(makeStatus({ insecureMode: true })) }),
    );
    expect(store.insecureMode).toBe(true);
  });

  it("names missing tools and warns", async () => {
    const store = useStatusStore();
    await store.load(
      stubApi({
        status: vi.fn().mockResolvedValue(makeStatus({ tools: { ytdlp: null, ffmpeg: null } })),
      }),
    );
    expect(store.missingTools).toEqual(["yt-dlp", "ffmpeg"]);
    expect(store.summary).toBe("yt-dlp, ffmpeg missing");
    expect(store.tone).toBe("warn");
  });

  it("puts a database failure ahead of missing tools", async () => {
    const store = useStatusStore();
    await store.load(
      stubApi({
        status: vi
          .fn()
          .mockResolvedValue(
            makeStatus({ db: { ok: false, migrations: 0 }, tools: { ytdlp: null, ffmpeg: "7" } }),
          ),
      }),
    );
    expect(store.dbOk).toBe(false);
    expect(store.summary).toBe("database error");
    expect(store.tone).toBe("error");
  });

  it("keeps the error and clears it on the next good load", async () => {
    const status = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError("http_503", "Not ready", 503))
      .mockResolvedValueOnce(makeStatus());
    const store = useStatusStore();
    await store.load(stubApi({ status }));
    expect(store.error?.problem).toBe("http_503");
    expect(store.summary).toBe("status unavailable");
    expect(store.tone).toBe("error");
    await store.load();
    expect(store.error).toBeNull();
    expect(store.summary).toBe("ready");
  });

  it("coalesces a burst of events into one refetch", async () => {
    vi.useFakeTimers();
    const api = stubApi();
    const store = useStatusStore();
    await store.load(api);
    store.applyEvent(EVENT);
    store.applyEvent(EVENT);
    store.applyEvent(EVENT);
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_DEBOUNCE_MS - 1);
    expect(api.status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.status).toHaveBeenCalledTimes(2);
    store.applyEvent(EVENT);
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_DEBOUNCE_MS);
    expect(api.status).toHaveBeenCalledTimes(3);
  });
});

describe("StatusPill", () => {
  async function pill(load?: () => Promise<void>) {
    const pinia = createPinia();
    setActivePinia(pinia);
    if (load !== undefined) await load();
    return mount(StatusPill, { global: { plugins: [pinia] } });
  }

  it("shows connecting before the first load", async () => {
    const wrapper = await pill();
    expect(wrapper.text()).toContain("connecting");
    expect(wrapper.classes()).toContain("tone-idle");
    expect(wrapper.find("[data-icon='check']").exists()).toBe(true);
  });

  it("shows ready with a check when everything is fine", async () => {
    const wrapper = await pill(() => useStatusStore().load(stubApi()));
    expect(wrapper.find(".status-pill__text").text()).toBe("ready");
    expect(wrapper.classes()).toContain("tone-idle");
  });

  it("warns with a shield when a tool is missing", async () => {
    const wrapper = await pill(() =>
      useStatusStore().load(
        stubApi({
          status: vi.fn().mockResolvedValue(makeStatus({ tools: { ytdlp: null, ffmpeg: "7" } })),
        }),
      ),
    );
    expect(wrapper.find(".status-pill__text").text()).toBe("yt-dlp missing");
    expect(wrapper.classes()).toContain("tone-warn");
    expect(wrapper.find("[data-icon='shield']").exists()).toBe(true);
  });

  it("shows an alert when the status cannot be read", async () => {
    const wrapper = await pill(() =>
      useStatusStore().load(stubApi({ status: vi.fn().mockRejectedValue(new Error("down")) })),
    );
    expect(wrapper.find(".status-pill__text").text()).toBe("status unavailable");
    expect(wrapper.classes()).toContain("tone-error");
    expect(wrapper.find("[data-icon='alert']").exists()).toBe(true);
  });

  it("reports the live-update connection to assistive technology", async () => {
    const wrapper = await pill();
    expect(wrapper.attributes("title")).toBe("Live updates idle");
    useEventsStore().state = "open";
    await wrapper.vm.$nextTick();
    expect(wrapper.attributes("title")).toBe("Live updates connected");
    expect(wrapper.find(".sr-only").text()).toBe("Live updates connected");
  });
});
