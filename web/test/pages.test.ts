import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import type { Component } from "vue";
import AboutPage from "../src/pages/AboutPage.vue";
import VideoDetailPage from "../src/pages/VideoDetailPage.vue";
import type { ApiClient } from "../src/api/client.ts";
import { NAV_LINKS, routes } from "../src/router/index.ts";
import { flush } from "./helpers/dom.ts";
import { mountGlobals } from "./helpers/mount.ts";
import { makeStatus, stubApi } from "./helpers/stubApi.ts";

let pinia: Pinia;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

async function load(path: string): Promise<Component> {
  const route = routes.find((candidate) => candidate.path === path);
  const component = route?.component;
  if (component === undefined || component === null) throw new Error(`no route for ${path}`);
  if (typeof component === "function") {
    const loaded = await (component as () => Promise<{ default: Component }>)();
    return loaded.default;
  }
  return component;
}

async function mountPage(component: Component, api: ApiClient = stubApi()) {
  const wrapper = mount(component, { global: mountGlobals({ api, pinia }) });
  await flush();
  return wrapper;
}

/** Pages that are no longer stubs; each has its own suite under test/<area>/. */
const IMPLEMENTED = new Set(["/about", "/notifications", "/activity", "/self-check"]);

describe("page stubs", () => {
  for (const link of NAV_LINKS.filter((candidate) => !IMPLEMENTED.has(candidate.to))) {
    it(`${link.label} renders its header and an empty state`, async () => {
      const wrapper = await mountPage(await load(link.to));
      expect(wrapper.find("h1").text()).toBe(link.label);
      expect(wrapper.find(".page-header p").text()).not.toBe("");
      expect(wrapper.find(".empty-state h2").text()).not.toBe("");
      expect(wrapper.find(`.empty-state [data-icon='${link.icon}']`).exists()).toBe(true);
    });
  }

  it("Video detail renders its header and an empty state", async () => {
    const wrapper = await mountPage(VideoDetailPage);
    expect(wrapper.find("h1").text()).toBe("Video");
    expect(wrapper.find(".empty-state").exists()).toBe(true);
  });

  it("uses ASCII only in every page's copy", async () => {
    for (const link of NAV_LINKS) {
      const wrapper = await mountPage(await load(link.to));
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(wrapper.text())).toBe(true);
    }
  });
});

describe("About page", () => {
  it("shows the version, tool versions and enforced authentication", async () => {
    const wrapper = await mountPage(AboutPage);
    expect(wrapper.find("h1").text()).toBe("About");
    expect(wrapper.find("[data-fact='version']").text()).toBe("0.1.0-test");
    expect(wrapper.find("[data-fact='auth']").text()).toBe("enforced");
    expect(wrapper.find("[data-fact='db']").text()).toBe("ok, 3 migrations");
    expect(wrapper.find("[data-tool='yt-dlp']").text()).toBe("2026.10.10");
    expect(wrapper.find("[data-tool='ffmpeg']").text()).toBe("7.1");
    expect(wrapper.text()).toContain("10 min ago");
    expect(wrapper.find(".cellar-note").exists()).toBe(false);
  });

  it("flags insecure mode, a missing tool, a database error and a SHA version", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const api = stubApi({
      status: vi.fn().mockResolvedValue(
        makeStatus({
          version: sha,
          insecureMode: true,
          db: { ok: false, migrations: 0 },
          tools: { ytdlp: null, ffmpeg: "7.1" },
        }),
      ),
    });
    const wrapper = await mountPage(AboutPage, api);
    expect(wrapper.find("[data-fact='version']").text()).toBe(sha.slice(0, 12));
    expect(wrapper.find("[data-fact='version']").attributes("title")).toBe(sha);
    expect(wrapper.find("[data-fact='auth']").text()).toBe("disabled");
    expect(wrapper.find("[data-fact='db']").text()).toBe("error");
    expect(wrapper.find("[data-tool='yt-dlp']").text()).toBe("not found");
    expect(wrapper.find(".cellar-note").text()).toContain("INSECURE_ALLOW_PUBLIC_ACCESS");
  });

  it("shows an error state, and retries", async () => {
    const status = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(makeStatus());
    const wrapper = await mountPage(AboutPage, stubApi({ status }));
    expect(wrapper.find(".error-state").exists()).toBe(true);
    await wrapper.find(".error-state button").trigger("click");
    await flush();
    expect(status).toHaveBeenCalledTimes(2);
    expect(wrapper.find(".error-state").exists()).toBe(false);
    expect(wrapper.find("[data-fact='version']").exists()).toBe(true);
  });

  it("says it is reading while the first load is in flight", async () => {
    const api = stubApi({ status: vi.fn().mockReturnValue(new Promise(() => undefined)) });
    const wrapper = await mountPage(AboutPage, api);
    expect(wrapper.text()).toContain("Reading instance status...");
  });

  it("refreshes on demand", async () => {
    const api = stubApi();
    const wrapper = await mountPage(AboutPage, api);
    const refresh = wrapper.findAll("button").find((button) => button.text() === "Refresh");
    await refresh!.trigger("click");
    expect(api.status).toHaveBeenCalledTimes(2);
  });
});
