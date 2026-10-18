import { beforeEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h, ref } from "vue";
import {
  DEFAULT_RULES,
  validateAst,
  type AstError,
  type ConditionNode,
  type Field,
} from "@cellar/shared";
import AutoComplete from "primevue/autocomplete";
import ConditionTree from "../../src/components/rules/ConditionTree.vue";
import { flush } from "../helpers/dom.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { fakeApi, type FakeApi } from "./fakeApi.ts";
import { byTest } from "./wrappers.ts";

beforeEach(() => {
  setActivePinia(createPinia());
});

const CHANNEL_ID = "UCaaaaaaaaaaaaaaaaaaaaaa";

function lookupApi(): FakeApi {
  return fakeApi({
    "GET /api/locations": {
      rows: [
        {
          id: 4,
          label: "Big disk",
          container_path: "/media/big",
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
    "GET /api/accounts": {
      rows: [
        {
          id: 2,
          label: "Main",
          email: null,
          channel_id: null,
          status: "ok",
          has_cookies: true,
          last_api_ok_at: null,
          last_cookie_ok_at: null,
          created_at: 1,
        },
      ],
    },
    "GET /api/channels": {
      rows: [
        {
          id: CHANNEL_ID,
          title: "Synthetic channel",
          handle: "@synthetic",
          thumbnail_url: null,
          subscribed: true,
          manual: false,
          video_count: 5,
        },
      ],
      total: 1,
      page: 1,
      perPage: 10,
    },
  });
}

/** Mounts the tree behind a v-model host so emitted ASTs flow back in like in the editor. */
async function mountTree(initial: ConditionNode | null, fake: FakeApi = lookupApi()) {
  const model = ref<ConditionNode | null>(initial);
  const errors = ref<AstError[]>([]);
  const Host = defineComponent({
    setup() {
      return () =>
        h(ConditionTree, {
          modelValue: model.value,
          "onUpdate:modelValue": (v: ConditionNode) => (model.value = v),
          onValidity: (e: AstError[]) => (errors.value = e),
        });
    },
  });
  const wrapper = mount(Host, { global: mountGlobals({ api: fake.api }) });
  await flush();
  return { wrapper, model, errors, fake };
}

async function pickChannel(wrapper: VueWrapper, value: unknown) {
  wrapper.findComponent(AutoComplete).vm.$emit("update:modelValue", value);
  await flush();
}

/** Emits a value from the PrimeVue component whose root carries `data-test`. */
async function choose(wrapper: VueWrapper, test: string, value: unknown, index = 0) {
  byTest(wrapper, test, index).vm.$emit("update:modelValue", value);
  await flush();
}

function firstLeaf(model: ConditionNode | null): Record<string, unknown> {
  if (model === null || model.type !== "group") throw new Error("expected a group");
  return model.children[0] as unknown as Record<string, unknown>;
}

describe("ConditionTree", () => {
  it("renders a default rule's nested tree with its summary", async () => {
    const { wrapper, errors } = await mountTree(DEFAULT_RULES[1]!.condition);
    expect(wrapper.findAll("[data-test='cond-group']")).toHaveLength(2);
    expect(wrapper.findAll("[data-test='cond-leaf']")).toHaveLength(3);
    expect(wrapper.find("[data-test='condition-summary']").text()).toContain(
      "Source has only subscription, channel",
    );
    expect(errors.value).toEqual([]);
  });

  it("adds a condition and a group, flips AND/OR and NOT, removes", async () => {
    const { wrapper, model } = await mountTree({ type: "group", op: "and", children: [] });
    expect(wrapper.find("[data-test='empty-group']").text()).toContain("matches every video");
    await wrapper.find("[data-test='add-leaf']").trigger("click");
    await wrapper.find("[data-test='add-group']").trigger("click");
    await flush();
    const root = model.value as { op: string; children: ConditionNode[] };
    expect(root.children).toHaveLength(2);
    expect(root.children[1]).toMatchObject({ type: "group", op: "or" });
    await choose(wrapper, "group-op", "or");
    await wrapper.find("[data-test='group-not'] input").setValue(true);
    await flush();
    expect(model.value).toMatchObject({ op: "or", not: true });
    expect(wrapper.find("[data-test='condition-summary']").text()).toContain("NOT (");
    await wrapper.find("[data-test='group-not'] input").setValue(false);
    await flush();
    expect((model.value as { not?: boolean }).not).toBeUndefined();
    await wrapper.findAll("[data-test='group-remove']")[0]!.trigger("click");
    await wrapper.find("[data-test='leaf-remove']").trigger("click");
    await flush();
    expect(model.value).toEqual({ type: "group", op: "or", children: [] });
    expect(wrapper.find("[data-test='empty-group']").text()).toContain("matches no videos");
  });

  it("emits a valid AST for every value kind", async () => {
    const steps: { field: Field; op?: string; act: (w: VueWrapper) => Promise<void> }[] = [
      { field: "views", act: (w) => choose(w, "value-number", 1000) },
      {
        field: "views",
        op: "between",
        act: async (w) => {
          await choose(w, "value-min", 10);
          await choose(w, "value-max", 20);
        },
      },
      { field: "duration_s", act: (w) => choose(w, "seconds-m", 5) },
      {
        field: "duration_s",
        op: "between",
        act: async (w) => {
          await choose(w, "seconds-h", 1, 1);
        },
      },
      { field: "is_hdr", act: (w) => choose(w, "value-bool", false) },
      { field: "title", act: (w) => choose(w, "value-text", "trailer") },
      { field: "title", op: "regex", act: (w) => choose(w, "value-regex", "^part [0-9]+$") },
      { field: "upload_date", act: (w) => choose(w, "age-months", 2) },
      {
        field: "upload_date",
        op: "after",
        act: (w) => choose(w, "value-instant", new Date(Date.UTC(2026, 0, 2))),
      },
      { field: "downloaded_at", op: "is_null", act: (w) => choose(w, "value-null", false) },
      { field: "status", act: (w) => choose(w, "value-enum", "gone") },
      { field: "status", op: "in", act: (w) => choose(w, "value-enum-list", ["gone", "unlisted"]) },
      { field: "source", act: (w) => choose(w, "value-enum-list", ["liked"]) },
      { field: "account", act: (w) => choose(w, "value-account", 2) },
      { field: "account", op: "in", act: (w) => choose(w, "value-accounts", [2]) },
      { field: "current_location", act: (w) => choose(w, "value-location", 4) },
      {
        field: "channel",
        act: (w) => pickChannel(w, { id: CHANNEL_ID, label: "Synthetic channel" }),
      },
      {
        field: "channel",
        op: "in",
        act: (w) => pickChannel(w, [{ id: CHANNEL_ID, label: "Synthetic channel" }]),
      },
      { field: "first_seen", act: (w) => choose(w, "leaf-source", "liked") },
    ];
    for (const step of steps) {
      const { wrapper, model, errors } = await mountTree({
        type: "group",
        op: "and",
        children: [{ type: "cond", field: "title", op: "contains", value: "" }],
      });
      await choose(wrapper, "leaf-field", step.field);
      if (step.op !== undefined) await choose(wrapper, "leaf-op", step.op);
      await step.act(wrapper);
      const result = validateAst(model.value);
      expect(result.ok, `${step.field} ${step.op ?? ""}: ${JSON.stringify(result.errors)}`).toBe(
        true,
      );
      expect(errors.value).toEqual([]);
      expect(firstLeaf(model.value)["field"]).toBe(step.field);
      wrapper.unmount();
    }
  });

  it("records the exact values the inputs produce", async () => {
    const { wrapper, model } = await mountTree({
      type: "group",
      op: "and",
      children: [{ type: "cond", field: "duration_s", op: "lt", value: 0 }],
    });
    await choose(wrapper, "seconds-h", 1);
    await choose(wrapper, "seconds-s", 30);
    expect(firstLeaf(model.value)["value"]).toBe(3630);
    await choose(wrapper, "leaf-field", "upload_date");
    await choose(wrapper, "age-days", null);
    await choose(wrapper, "age-years", 1);
    expect(firstLeaf(model.value)["value"]).toEqual({ years: 1 });
    expect(wrapper.find("[data-test='age-summary']").text()).toBe("1 year");
    await choose(wrapper, "leaf-op", "before");
    await choose(wrapper, "value-instant", new Date(Date.UTC(2025, 4, 6, 7, 8)));
    expect(firstLeaf(model.value)["value"]).toBe("2025-05-06T07:08:00.000Z");
    await choose(wrapper, "value-instant", null);
    expect(firstLeaf(model.value)["value"]).toBeNull();
  });

  it("keeps the case-insensitive flag and shows the regex hint", async () => {
    const { wrapper, model } = await mountTree({
      type: "group",
      op: "and",
      children: [{ type: "cond", field: "title", op: "regex", value: "a" }],
    });
    expect(wrapper.find("[data-test='regex-hint']").exists()).toBe(true);
    await wrapper.find("[data-test='leaf-ci'] input").setValue(true);
    await flush();
    expect(firstLeaf(model.value)).toMatchObject({ op: "regex", ci: true });
  });

  it("edits an ISO duration it cannot split as raw text", async () => {
    const { wrapper, model } = await mountTree({
      type: "group",
      op: "and",
      children: [{ type: "cond", field: "last_seen", op: "age_gt", value: "PT30M" }],
    });
    expect(wrapper.find("[data-test='age-summary']").text()).toBe("30 minutes");
    await choose(wrapper, "age-iso", "PT45M");
    expect(firstLeaf(model.value)["value"]).toBe("PT45M");
  });

  it("shows validation errors inline by JSON pointer", async () => {
    const { wrapper, errors } = await mountTree({
      type: "group",
      op: "and",
      children: [
        { type: "cond", field: "views", op: "between", value: [10, 1] },
        { type: "cond", field: "title", op: "regex", value: "(a+)+" },
        { type: "cond", field: "status", op: "in", value: [] },
      ],
    } as unknown as ConditionNode);
    const messages = wrapper.findAll("[data-test='leaf-error']").map((li) => li.text());
    expect(messages).toHaveLength(3);
    expect(messages[0]).toContain("/children/0/value");
    expect(messages[0]).toContain("min <= max");
    expect(messages[1]).toContain("/children/1/value");
    expect(messages[2]).toContain("/children/2/value");
    expect(errors.value.map((e) => e.code)).toContain("unsafe_regex");
    expect(wrapper.findAll(".cond-leaf--invalid")).toHaveLength(3);
  });

  it("moves conditions with the keyboard buttons", async () => {
    const { wrapper, model } = await mountTree({
      type: "group",
      op: "and",
      children: [
        { type: "cond", field: "views", op: "gt", value: 1 },
        { type: "cond", field: "likes", op: "gt", value: 2 },
      ],
    });
    await wrapper.findAll("[data-test='leaf-down']")[0]!.trigger("click");
    await flush();
    const fields = () =>
      (model.value as { children: { field: string }[] }).children.map((c) => c.field);
    expect(fields()).toEqual(["likes", "views"]);
    await wrapper.findAll("[data-test='leaf-up']")[1]!.trigger("click");
    await flush();
    expect(fields()).toEqual(["views", "likes"]);
  });

  it("drags a condition into another group and groups between levels", async () => {
    const { wrapper, model } = await mountTree({
      type: "group",
      op: "and",
      children: [
        { type: "cond", field: "views", op: "gt", value: 1 },
        {
          type: "group",
          op: "or",
          children: [{ type: "cond", field: "likes", op: "gt", value: 2 }],
        },
      ],
    });
    const handle = wrapper.findAll("[data-test='leaf-handle']")[0]!;
    await handle.trigger("dragstart");
    await flush();
    const nested = wrapper.findAll("[data-test='cond-group']")[1]!;
    const end = nested.find("[data-test='drop-end']");
    expect(end.exists()).toBe(true);
    await end.trigger("dragover");
    await end.trigger("drop");
    await flush();
    expect(model.value).toEqual({
      type: "group",
      op: "and",
      children: [
        {
          type: "group",
          op: "or",
          children: [
            { type: "cond", field: "likes", op: "gt", value: 2 },
            { type: "cond", field: "views", op: "gt", value: 1 },
          ],
        },
      ],
    });

    // Drag the nested "views" row back out, dropping it before the group.
    await wrapper.findAll("[data-test='leaf-handle']")[1]!.trigger("dragstart");
    await flush();
    const rootSlot = wrapper.findAll("[data-test='cond-slot']")[0]!;
    await rootSlot.trigger("dragover");
    await rootSlot.trigger("drop");
    await flush();
    const root = model.value as { children: { type: string; field?: string }[] };
    expect(root.children.map((c) => c.field ?? c.type)).toEqual(["views", "group"]);

    // A group cannot be dropped into itself; dragend clears the drag.
    await wrapper.find("[data-test='group-handle']").trigger("dragstart");
    await flush();
    const ownEnd = wrapper.findAll("[data-test='cond-group']")[1]!.find("[data-test='drop-end']");
    await ownEnd.trigger("drop");
    await flush();
    expect(root.children).toHaveLength(2);
    await wrapper.find("[data-test='group-handle']").trigger("dragstart");
    await wrapper.find("[data-test='group-handle']").trigger("dragend");
    await flush();
    expect(wrapper.find("[data-test='drop-end']").exists()).toBe(false);
    // Dropping with nothing dragged is a no-op.
    await wrapper.findAll("[data-test='cond-slot']")[0]!.trigger("drop");
  });

  it("moves groups with the keyboard and resets when the model is replaced", async () => {
    const { wrapper, model } = await mountTree({
      type: "group",
      op: "and",
      children: [
        { type: "group", op: "or", children: [] },
        { type: "cond", field: "views", op: "gt", value: 1 },
      ],
    });
    await wrapper.find("[data-test='group-down']").trigger("click");
    await flush();
    expect((model.value as { children: { type: string }[] }).children[1]!.type).toBe("group");
    await wrapper.find("[data-test='group-up']").trigger("click");
    await flush();
    expect((model.value as { children: { type: string }[] }).children[0]!.type).toBe("group");
    model.value = DEFAULT_RULES[6]!.condition;
    await flush();
    expect(wrapper.findAll("[data-test='cond-leaf']")).toHaveLength(1);
    expect(wrapper.find("[data-test='condition-summary']").text()).toContain("unlisted, gone");
  });

  it("resolves channel titles and searches as you type", async () => {
    const { wrapper, model, fake } = await mountTree({
      type: "group",
      op: "and",
      children: [{ type: "cond", field: "channel", op: "eq", value: CHANNEL_ID }],
    });
    expect(fake.callsTo("GET /api/channels")[0]?.query.get("q")).toBe(CHANNEL_ID);
    expect(wrapper.find("[data-test='condition-summary']").text()).toContain("Synthetic channel");
    const picker = wrapper.findComponent(AutoComplete);
    picker.vm.$emit("complete", { query: "synth" });
    await flush();
    expect(fake.callsTo("GET /api/channels").at(-1)?.query.get("q")).toBe("synth");
    // Typing keeps the text local; a pasted id is accepted on blur.
    picker.vm.$emit("update:modelValue", "UCbbbbbbbbbbbbbbbbbbbbbb");
    await flush();
    expect(firstLeaf(model.value)["value"]).toBe(CHANNEL_ID);
    picker.vm.$emit("blur");
    await flush();
    expect(firstLeaf(model.value)["value"]).toBe("UCbbbbbbbbbbbbbbbbbbbbbb");
    picker.vm.$emit("update:modelValue", null);
    await flush();
    expect(firstLeaf(model.value)["value"]).toBeNull();
  });
});
