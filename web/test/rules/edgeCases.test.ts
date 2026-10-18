import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { defineComponent, h, ref } from "vue";
import AutoComplete from "primevue/autocomplete";
import type { ConditionNode } from "@cellar/shared";
import CaptionsForm from "../../src/components/rules/CaptionsForm.vue";
import ConditionTree from "../../src/components/rules/ConditionTree.vue";
import EffectsEditor from "../../src/components/rules/EffectsEditor.vue";
import IdListChoice from "../../src/components/rules/IdListChoice.vue";
import RulePreviewPanel from "../../src/components/rules/RulePreviewPanel.vue";
import InspectPanel from "../../src/components/inspect/InspectPanel.vue";
import RulesPage from "../../src/pages/RulesPage.vue";
import { flush } from "../helpers/dom.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { fakeApi, makeInspect, makeRow, type FakeApi } from "./fakeApi.ts";
import { byTest } from "./wrappers.ts";

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.useRealTimers();
});

function transfer(): DataTransfer {
  return new DataTransfer();
}

function mountTree(initial: ConditionNode, fake: FakeApi = fakeApi()) {
  const model = ref<ConditionNode | null>(initial);
  const Host = defineComponent({
    setup: () => () =>
      h(ConditionTree, {
        modelValue: model.value,
        "onUpdate:modelValue": (v: ConditionNode) => (model.value = v),
      }),
  });
  return { wrapper: mount(Host, { global: mountGlobals({ api: fake.api }) }), model };
}

describe("condition builder edge cases", () => {
  it("renders leaves whose values have the wrong type, and flags them", async () => {
    const { wrapper } = mountTree({
      type: "group",
      op: "and",
      children: [
        { type: "cond", field: "views", op: "gt", value: "x" },
        { type: "cond", field: "views", op: "between", value: "x" },
        { type: "cond", field: "likes", op: "between", value: ["a", "b"] },
        { type: "cond", field: "title", op: "contains", value: null },
        { type: "cond", field: "tags", op: "regex", value: null },
        { type: "cond", field: "status", op: "in", value: "x" },
        { type: "cond", field: "account", op: "in", value: "x" },
        { type: "cond", field: "channel", op: "in", value: "x" },
        { type: "cond", field: "duration_s", op: "gt", value: "x" },
        { type: "cond", field: "last_seen", op: "before", value: 1767225600000 },
      ],
    } as unknown as ConditionNode);
    await flush();
    expect(wrapper.findAll("[data-test='cond-leaf']")).toHaveLength(10);
    expect(wrapper.findAll(".cond-leaf--invalid")).toHaveLength(9);
    expect(wrapper.find("[data-test='condition-summary']").text()).toContain(
      "Last seen before 2026-01-01",
    );
  });

  it("clears the first_seen source, adds AND groups under OR, zeroes empty seconds", async () => {
    const { wrapper, model } = mountTree({
      type: "group",
      op: "or",
      children: [
        { type: "cond", field: "first_seen", source: "liked", op: "age_gt", value: "P1D" },
        { type: "cond", field: "duration_s", op: "gt", value: 70 },
      ],
    });
    await flush();
    byTest(wrapper, "leaf-source").vm.$emit("update:modelValue", null);
    byTest(wrapper, "seconds-m").vm.$emit("update:modelValue", null);
    await wrapper.find("[data-test='add-group']").trigger("click");
    await flush();
    const root = model.value as { children: Record<string, unknown>[] };
    expect(root.children[0]).not.toHaveProperty("source");
    expect(root.children[1]!["value"]).toBe(10);
    expect(root.children[2]).toMatchObject({ type: "group", op: "and" });
  });

  it("carries a DataTransfer through drags and ignores stray dragovers", async () => {
    const { wrapper, model } = mountTree({
      type: "group",
      op: "and",
      children: [
        { type: "cond", field: "views", op: "gt", value: 1 },
        { type: "group", op: "or", children: [] },
      ],
    });
    await flush();
    const slot = wrapper.findAll("[data-test='cond-slot']")[0]!;
    await slot.trigger("dragover", { dataTransfer: transfer() });
    expect(slot.classes()).not.toContain("cond-slot--target");
    await wrapper.find("[data-test='group-handle']").trigger("dragstart", {
      dataTransfer: transfer(),
    });
    await slot.trigger("dragover", { dataTransfer: transfer() });
    expect(slot.classes()).toContain("cond-slot--target");
    await slot.trigger("dragleave");
    await slot.trigger("drop", { dataTransfer: transfer() });
    await flush();
    expect((model.value as { children: { type: string }[] }).children[0]!.type).toBe("group");
    await wrapper.find("[data-test='leaf-handle']").trigger("dragstart", {
      dataTransfer: transfer(),
    });
    await flush();
    const end = wrapper.findAll("[data-test='drop-end']")[0]!;
    await end.trigger("dragover", { dataTransfer: transfer() });
    expect(end.classes()).toContain("cond-dropzone--target");
    await end.trigger("dragleave");
    await wrapper.find("[data-test='leaf-handle']").trigger("dragend");
  });

  it("shows an error on a group nested too deep", async () => {
    let node: ConditionNode = { type: "cond", field: "views", op: "gt", value: 1 };
    for (let i = 0; i < 17; i += 1) node = { type: "group", op: "and", children: [node] };
    const { wrapper } = mountTree(node);
    await flush();
    expect(wrapper.find("[data-test='group-error']").text()).toContain("nest at most 16");
  });

  it("keeps typed channel text while search results arrive, and clears a list", async () => {
    const fake = fakeApi({
      "GET /api/channels": (call: { query: URLSearchParams }) => ({
        rows: [
          {
            id: `UC${call.query.get("q")}`.padEnd(24, "x").slice(0, 24),
            title: `Channel ${call.query.get("q")}`,
            handle: null,
            thumbnail_url: null,
            subscribed: true,
            manual: false,
            video_count: 1,
          },
        ],
        total: 1,
        page: 1,
        perPage: 10,
      }),
    });
    const { wrapper, model } = mountTree(
      {
        type: "group",
        op: "and",
        children: [
          { type: "cond", field: "channel", op: "eq", value: "UCaaaaaaaaaaaaaaaaaaaaaa" },
          { type: "cond", field: "channel", op: "in", value: ["UCbbbbbbbbbbbbbbbbbbbbbb"] },
        ],
      },
      fake,
    );
    await flush();
    const single = wrapper.findAllComponents(AutoComplete)[0]!;
    single.vm.$emit("update:modelValue", "new");
    await flush();
    single.vm.$emit("complete", { query: "new" });
    await flush();
    expect(single.props("modelValue")).toBe("new");
    // Search failures leave the suggestions empty.
    fake.on("GET /api/channels", () => {
      throw new Error("offline");
    });
    single.vm.$emit("complete", { query: "zz" });
    await flush();
    expect(single.props("suggestions")).toEqual([]);
    const multi = wrapper.findAllComponents(AutoComplete)[1]!;
    multi.vm.$emit("update:modelValue", null);
    await flush();
    expect((model.value as { children: { value: unknown }[] }).children[1]!.value).toEqual([]);
  });
});

describe("effects editor edge cases", () => {
  function mountEffects(initial: Record<string, unknown>, fake: FakeApi = fakeApi()) {
    const model = ref<Record<string, unknown>>(initial);
    const Host = defineComponent({
      setup: () => () =>
        h(EffectsEditor, {
          modelValue: model.value,
          kind: "custom",
          "onUpdate:modelValue": (v: Record<string, unknown>) => (model.value = v),
        }),
    });
    return { wrapper: mount(Host, { global: mountGlobals({ api: fake.api }) }), model };
  }

  it("renders effects whose values have the wrong shape, and unknown keys", async () => {
    const { wrapper, model } = mountEffects({
      reclaim_priority: "x",
      transcode: null,
      captions: null,
      ytdlp: null,
      notify: "x",
      bogus: 1,
    });
    await flush();
    expect(wrapper.findAll("[data-effect]")).toHaveLength(5);
    expect(wrapper.text()).toContain("Unrecognized key");
    byTest(wrapper, "transcode-quality").vm.$emit("update:modelValue", 20);
    await flush();
    byTest(wrapper, "ytdlp-fragments").vm.$emit("update:modelValue", 2);
    await flush();
    byTest(wrapper, "notify-enabled").vm.$emit("update:modelValue", true);
    await flush();
    expect(model.value["transcode"]).toEqual({ quality: 20 });
    expect(model.value["ytdlp"]).toEqual({ concurrent_fragments: 2 });
    byTest(wrapper, "notify-max").vm.$emit("update:modelValue", null);
    await flush();
    expect(model.value["notify"]).toEqual({ enabled: true, max_times: 1 });
  });

  it("handles cleared text inputs", async () => {
    const { wrapper, model } = mountEffects({
      ytdlp: { extra_args_allowlisted: ["--no-mtime"] },
      delay_after_upload: "PT30M",
      captions: { enabled: true, languages: ["en"], auto_generated: true },
    });
    await flush();
    byTest(wrapper, "ytdlp-arg").vm.$emit("update:modelValue", undefined);
    await flush();
    byTest(wrapper, "age-iso").vm.$emit("update:modelValue", undefined);
    await flush();
    byTest(wrapper, "captions-languages").vm.$emit("update:modelValue", undefined);
    await flush();
    expect(model.value["ytdlp"]).toEqual({ extra_args_allowlisted: [""] });
    expect(model.value["delay_after_upload"]).toBe("");
    expect(model.value["captions"]).toMatchObject({ languages: [] });
  });

  it("labels disabled proxies", async () => {
    const fake = fakeApi({
      "GET /api/proxies": {
        rows: [
          {
            id: 6,
            label: "Old",
            url_redacted: "socks5://***",
            enabled: false,
            fail_count: 4,
            skipped_until: null,
          },
        ],
      },
    });
    const { wrapper } = mountEffects({ proxy: [6] }, fake);
    await flush();
    expect(byTest(wrapper, "id-list-ids").props("options" as never)).toEqual([
      { label: "Old (disabled)", value: 6 },
    ]);
  });

  it("starts an explicit list empty when there is nothing to choose", async () => {
    const wrapper = mount(IdListChoice, {
      props: {
        modelValue: "none",
        modes: [{ label: "None", value: "none" }],
        options: [],
        listLabel: "Specific",
      },
      global: mountGlobals(),
    });
    byTest(wrapper, "id-list-mode").vm.$emit("update:modelValue", "__list");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([[]]);
  });

  it("follows an external language change and restores typed languages", async () => {
    const wrapper = mount(CaptionsForm, {
      props: { modelValue: { enabled: true, languages: ["en"], auto_generated: true } },
      global: mountGlobals(),
    });
    await wrapper.setProps({ modelValue: { enabled: true, languages: ["de", "fr"] } });
    expect(
      (wrapper.find("[data-test='captions-languages']").element as HTMLInputElement).value,
    ).toBe("de, fr");
    await wrapper.setProps({ modelValue: { enabled: true, languages: "all" } });
    await wrapper.find("[data-test='captions-all'] input").setValue(false);
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([
      { enabled: true, languages: ["de", "fr"] },
    ]);
  });
});

describe("page and panel edge cases", () => {
  it("resolves channel titles for rule summaries and handles drag details", async () => {
    const rows = [
      makeRow({ id: 1, kind: "global", position: 0, name: "Global defaults", condition: null }),
      makeRow({
        id: 2,
        position: 1,
        name: "One channel",
        condition: {
          type: "group",
          op: "and",
          children: [
            { type: "cond", field: "channel", op: "eq", value: "UCcccccccccccccccccccccc" },
          ],
        },
      }),
      makeRow({ id: 3, position: 2, name: "Second" }),
    ];
    const fake = fakeApi({
      "GET /api/rules": { rows },
      "GET /api/channels": {
        rows: [
          {
            id: "UCcccccccccccccccccccccc",
            title: "Cooking",
            handle: null,
            thumbnail_url: null,
            subscribed: true,
            manual: false,
            video_count: 9,
          },
        ],
        total: 1,
        page: 1,
        perPage: 10,
      },
    });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/rules", component: defineComponent({ render: () => null }) }],
    });
    await router.push("/rules");
    const wrapper = mount(RulesPage, { global: mountGlobals({ api: fake.api, router }) });
    await flush(5);
    expect(wrapper.find("[data-test='custom-rule'] [data-test='rule-summary']").text()).toContain(
      "Channel is Cooking",
    );
    const items = wrapper.findAll("[data-test='custom-rule']");
    await items[0]!.trigger("dragover", { dataTransfer: transfer() });
    expect(items[0]!.classes()).not.toContain("rules-page__row--over");
    await items[0]!.trigger("dragstart", { dataTransfer: transfer() });
    await items[0]!.trigger("dragover", { dataTransfer: transfer() });
    await items[0]!.trigger("drop", { dataTransfer: transfer() });
    await flush();
    expect(fake.callsTo("PUT /api/rules/order")).toHaveLength(0);
  });

  it("reads provenance gaps as default, cancels a stale inspect, and cancels clearing", async () => {
    const provenance: Record<string, number | "default"> = { ...makeInspect().provenance };
    delete provenance["media_mode"];
    let release: (() => void) | null = null;
    const fake = fakeApi({
      "GET /api/inspect": (call: { query: URLSearchParams }) =>
        call.query.get("id") === "aaaaaaaaaaa"
          ? new Promise((resolve) => {
              release = () => resolve(makeInspect());
            })
          : makeInspect({ provenance, overrides: { include: false } }),
    });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/:any(.*)", component: defineComponent({ render: () => null }) }],
    });
    await router.push("/inspect");
    const wrapper = mount(InspectPanel, {
      props: { videoId: "aaaaaaaaaaa" },
      global: mountGlobals({ api: fake.api, router }),
    });
    await flush();
    await wrapper.setProps({ videoId: "dQw4w9WgXcQ" });
    await flush(5);
    (release as (() => void) | null)?.();
    await flush();
    expect(wrapper.find(".error-state").exists()).toBe(false);
    expect(wrapper.find("[data-effect='media_mode'] [data-test='setting-source']").text()).toBe(
      "default",
    );
    await wrapper.find("[data-test='overrides-clear']").trigger("click");
    await flush();
    await wrapper
      .findAll(".p-dialog button")
      .find((b) => b.text() === "Cancel")!
      .trigger("click");
    await flush();
    expect(wrapper.find(".p-dialog").exists()).toBe(false);
    expect(fake.callsTo("PUT /api/videos/dQw4w9WgXcQ/overrides")).toHaveLength(0);
  });

  it("drops a superseded preview request without an error", async () => {
    vi.useFakeTimers();
    const fake = fakeApi({
      "POST /api/rules/preview": () => new Promise(() => undefined),
    });
    const condition = { type: "group" as const, op: "and" as const, children: [] };
    const wrapper = mount(RulePreviewPanel, {
      props: { condition, valid: true },
      global: mountGlobals({ api: fake.api }),
    });
    await vi.advanceTimersByTimeAsync(400);
    await wrapper.setProps({ condition: { ...condition, op: "or" as const } });
    await vi.advanceTimersByTimeAsync(10);
    expect(wrapper.find("[data-test='preview-error']").exists()).toBe(false);
    wrapper.unmount();
  });
});
