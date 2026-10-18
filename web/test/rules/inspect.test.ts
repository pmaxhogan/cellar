import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { defineComponent } from "vue";
import InspectPage from "../../src/pages/InspectPage.vue";
import InspectPanel from "../../src/components/inspect/InspectPanel.vue";
import { flush } from "../helpers/dom.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { Reply, fakeApi, makeInspect, type FakeApi } from "./fakeApi.ts";
import { byTest } from "./wrappers.ts";

beforeEach(() => {
  setActivePinia(createPinia());
});

const VIDEO = "dQw4w9WgXcQ";

function makeRouter(): Router {
  const blank = defineComponent({ render: () => null });
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/inspect", component: blank },
      { path: "/rules", component: blank },
    ],
  });
}

function inspectApi(): FakeApi {
  return fakeApi({
    "GET /api/inspect": makeInspect(),
    "GET /api/locations": {
      rows: [
        {
          id: 1,
          label: "NAS",
          container_path: "/media/nas",
          quota_bytes: 0,
          enabled: true,
          used_bytes: 0,
          fs_free_bytes: null,
          mounted: true,
          created_at: 1,
          updated_at: 1,
        },
      ],
    },
    "GET /api/accounts": { rows: [] },
    "GET /api/proxies": { rows: [] },
  });
}

async function mountInspect(fake: FakeApi, path = "/inspect") {
  const router = makeRouter();
  await router.push(path);
  const wrapper = mount(InspectPage, { global: mountGlobals({ api: fake.api, router }) });
  await flush(5);
  return { wrapper, router };
}

describe("InspectPage", () => {
  it("normalises a pasted URL, inspects it and mirrors the id into the query", async () => {
    const fake = inspectApi();
    const { wrapper, router } = await mountInspect(fake);
    expect(wrapper.find(".empty-state").exists()).toBe(true);
    expect(wrapper.find("[data-test='inspect-submit']").attributes("disabled")).toBeDefined();
    await wrapper.find("[data-test='inspect-input']").setValue("not a video");
    expect(wrapper.find("[data-test='inspect-invalid']").exists()).toBe(true);
    await wrapper.find("[data-test='inspect-form']").trigger("submit");
    expect(fake.calls).toHaveLength(0);
    await wrapper
      .find("[data-test='inspect-input']")
      .setValue(`https://www.youtube.com/watch?list=PL1&v=${VIDEO}&t=42`);
    expect(wrapper.find("[data-test='inspect-parsed']").text()).toBe(`Video id ${VIDEO}`);
    await wrapper.find("[data-test='inspect-form']").trigger("submit");
    await flush(5);
    expect(fake.callsTo("GET /api/inspect")[0]?.query.get("id")).toBe(VIDEO);
    expect(router.currentRoute.value.query["id"]).toBe(VIDEO);
    expect(wrapper.find("[data-test='inspect-video']").text()).toContain("A synthetic video");
    expect(wrapper.find("[data-test='inspect-known']").text()).toBe("known");
  });

  it("shows matched rules in priority order and provenance per key", async () => {
    const { wrapper } = await mountInspect(inspectApi(), `/inspect?id=${VIDEO}`);
    const matched = wrapper.findAll("[data-test='matched-rule']");
    expect(matched.map((li) => li.find("a").text())).toEqual([
      "Global defaults",
      "Keep unlisted and gone forever",
    ]);
    expect(matched[1]!.find("a").attributes("href")).toBe("/rules?edit=7");
    const row = (key: string) => wrapper.find(`[data-effect='${key}']`);
    expect(row("reclaim_priority").find("[data-test='setting-value']").text()).toBe("never delete");
    expect(row("reclaim_priority").find("[data-test='source-link']").text()).toBe(
      "Keep unlisted and gone forever",
    );
    expect(row("include").find("[data-test='setting-source']").text()).toBe("default");
    expect(row("location_id").find("[data-test='setting-value']").text()).toBe(
      "First enabled location",
    );
    expect(row("captions").find("[data-test='setting-value']").text()).toBe("en, auto");
    expect(row("captions").find("[data-test='source-link']").attributes("href")).toBe(
      "/rules?edit=1",
    );
    expect(wrapper.findAll("[data-test='inspect-settings'] tbody tr")).toHaveLength(16);
  });

  it("follows the query when it changes", async () => {
    const fake = inspectApi();
    const { wrapper, router } = await mountInspect(fake, `/inspect?id=${VIDEO}`);
    await router.push("/inspect?id=https://youtu.be/aaaaaaaaaaa");
    await flush(5);
    expect(fake.callsTo("GET /api/inspect").at(-1)?.query.get("id")).toBe("aaaaaaaaaaa");
    expect((wrapper.find("[data-test='inspect-input']").element as HTMLInputElement).value).toBe(
      "https://youtu.be/aaaaaaaaaaa",
    );
    await router.push("/inspect");
    await flush();
    expect(fake.callsTo("GET /api/inspect")).toHaveLength(2);
  });

  it("works without a router for the page shell", async () => {
    const wrapper = mount(InspectPage, { global: mountGlobals({ api: inspectApi().api }) });
    await flush();
    await wrapper.find("[data-test='inspect-input']").setValue(VIDEO);
    await wrapper.find("[data-test='inspect-form']").trigger("submit");
    await flush();
    await flush(5);
    expect(wrapper.findComponent(InspectPanel).props("videoId")).toBe(VIDEO);
    expect(wrapper.find("[data-test='matched-rule'] a").attributes("href")).toBe("/rules?edit=1");
  });
});

describe("InspectPanel", () => {
  async function mountPanel(fake: FakeApi) {
    const router = makeRouter();
    await router.push("/inspect");
    const wrapper = mount(InspectPanel, {
      props: { videoId: VIDEO },
      global: mountGlobals({ api: fake.api, router }),
    });
    await flush(5);
    return wrapper;
  }

  it("saves overrides with the effects editor and clears them with null", async () => {
    const fake = inspectApi();
    fake.on("PUT /api/videos/dQw4w9WgXcQ/overrides", (call: { body: unknown }) => {
      const effects = (call.body as { effects: Record<string, unknown> | null }).effects;
      return makeInspect({
        overrides: effects,
        matched: [
          { id: 1, kind: "global", name: "Global defaults", position: 0 },
          ...(effects === null
            ? []
            : [{ id: 90, kind: "video" as const, name: "Video override", position: 0 }]),
        ],
        provenance: { ...makeInspect().provenance, include: effects === null ? "default" : 90 },
        effective: { ...makeInspect().effective, include: effects === null },
      });
    });
    const wrapper = await mountPanel(fake);
    expect(wrapper.find("[data-test='overrides-save']").attributes("disabled")).toBeDefined();
    expect(wrapper.find("[data-test='overrides-clear']").attributes("disabled")).toBeDefined();
    byTest(wrapper, "effect-add").vm.$emit("update:modelValue", "include");
    await flush();
    byTest(wrapper, "effect-toggle").vm.$emit("update:modelValue", false);
    await flush();
    await wrapper.find("[data-test='overrides-save']").trigger("click");
    await flush();
    expect(fake.callsTo("PUT /api/videos/dQw4w9WgXcQ/overrides")[0]?.body).toEqual({
      effects: { include: false },
    });
    const include = wrapper.find("[data-effect='include']");
    expect(include.find("[data-test='setting-value']").text()).toBe("no (excluded)");
    expect(include.find("[data-test='source-override']").attributes("href")).toBe(
      "#inspect-overrides",
    );
    expect(wrapper.find("[data-test='overrides-save']").attributes("disabled")).toBeDefined();

    await wrapper.find("[data-test='overrides-clear']").trigger("click");
    await flush();
    const confirm = wrapper.findAll(".p-dialog button").find((b) => b.text() === "Clear");
    await confirm!.trigger("click");
    await flush();
    expect(fake.callsTo("PUT /api/videos/dQw4w9WgXcQ/overrides")[1]?.body).toEqual({
      effects: null,
    });
    expect(wrapper.find("[data-effect='include'] [data-test='setting-source']").text()).toBe(
      "default",
    );
  });

  it("sends null when every override is removed, and reports failures", async () => {
    const fake = inspectApi();
    fake.on("GET /api/inspect", makeInspect({ overrides: { reclaim_priority: 0 } }));
    fake.on("PUT /api/videos/dQw4w9WgXcQ/overrides", new Reply(500, { error: "disk full" }));
    const wrapper = await mountPanel(fake);
    await wrapper.find("[data-test='effect-unset']").trigger("click");
    await flush();
    await wrapper.find("[data-test='overrides-save']").trigger("click");
    await flush();
    expect(fake.callsTo("PUT /api/videos/dQw4w9WgXcQ/overrides")[0]?.body).toEqual({
      effects: null,
    });
    expect(wrapper.find("[data-test='overrides-save']").attributes("disabled")).toBeUndefined();
  });

  it("explains an unknown video and retries after an error", async () => {
    const fake = inspectApi();
    fake.on("GET /api/inspect", new Reply(400, { error: "not a video id" }));
    const wrapper = await mountPanel(fake);
    expect(wrapper.find(".error-state").text()).toContain("not a video id");
    fake.on(
      "GET /api/inspect",
      makeInspect({ known: false, title: null, channel_title: null, evaluated_at: null }),
    );
    await wrapper.find(".error-state button").trigger("click");
    await flush(5);
    expect(wrapper.find("[data-test='inspect-known']").text()).toBe("not in catalog");
    expect(wrapper.find("[data-test='inspect-unknown']").exists()).toBe(true);
    expect(wrapper.find("[data-test='inspect-video'] h2").text()).toBe("Untitled video");
  });

  it("lists no rules when nothing matches and names an unknown provenance rule", async () => {
    const fake = inspectApi();
    fake.on(
      "GET /api/inspect",
      makeInspect({ matched: [], provenance: { ...makeInspect().provenance, media_mode: 42 } }),
    );
    const wrapper = await mountPanel(fake);
    expect(wrapper.find("[data-test='inspect-matched']").text()).toContain("No rules match.");
    expect(wrapper.find("[data-effect='media_mode'] [data-test='source-link']").text()).toBe(
      "rule #42",
    );
  });
});
