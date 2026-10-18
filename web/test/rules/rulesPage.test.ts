import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { defineComponent } from "vue";
import type { RuleRow } from "@cellar/shared";
import RulesPage from "../../src/pages/RulesPage.vue";
import RuleEditor from "../../src/components/rules/RuleEditor.vue";
import RulePreviewPanel from "../../src/components/rules/RulePreviewPanel.vue";
import { flush } from "../helpers/dom.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { Reply, defaultRows, fakeApi, makeRow, type FakeApi } from "./fakeApi.ts";
import { byTest } from "./wrappers.ts";

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.useRealTimers();
});

function renumbered(rows: RuleRow[], ids: number[]): RuleRow[] {
  return rows.map((row) => {
    const index = ids.indexOf(row.id);
    return index < 0 ? row : { ...row, position: index + 1 };
  });
}

function pageApi(rows: RuleRow[] = defaultRows()): FakeApi {
  let current = rows;
  return fakeApi({
    "GET /api/rules": () => ({ rows: current }),
    "PUT /api/rules/order": (call: { body: unknown }) => {
      current = renumbered(current, (call.body as { ids: number[] }).ids);
      return { rows: current };
    },
    "POST /api/rules/preview": { count: 3, total: 40, sample: [] },
    "GET /api/locations": { rows: [] },
    "GET /api/accounts": { rows: [] },
    "GET /api/proxies": { rows: [] },
    "GET /api/channels": { rows: [], total: 0, page: 1, perPage: 10 },
  });
}

async function mountPage(fake: FakeApi, path = "/rules") {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/rules", component: defineComponent({ render: () => null }) }],
  });
  await router.push(path);
  const wrapper = mount(RulesPage, { global: mountGlobals({ api: fake.api, router }) });
  await flush(5);
  return wrapper;
}

function names(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper
    .findAll("[data-test='custom-rule'] [data-test='rule-name']")
    .map((el) => el.text());
}

describe("RulesPage: list", () => {
  it("pins the global rule and lists custom rules by ascending priority", async () => {
    const wrapper = await mountPage(pageApi());
    const global = wrapper.find("[data-test='global-rule']");
    expect(global.text()).toContain("Global defaults");
    expect(global.find("[data-test='rule-summary']").text()).toContain("every video");
    expect(global.find("[data-test='rule-delete']").exists()).toBe(false);
    expect(names(wrapper)).toEqual([
      "Expire: subscriptions after 2 weeks",
      "Expire: watched after 2 months",
      "Expire: liked after 2 years",
      "Guard: no subscription backfill older than 7 days before install",
      "Captions: English only",
      "Keep unlisted and gone forever",
      "Notify when a video goes gone",
    ]);
    expect(wrapper.find("[data-test='priority-hint']").text()).toContain(
      "Higher in the list = lower priority",
    );
    const first = wrapper.findAll("[data-test='custom-rule']")[0]!;
    expect(first.find("[data-test='rule-summary']").text()).toContain("Source has only");
    expect(first.find("[data-test='rule-chip']").text()).toBe("Reclaim priority: delete now");
    expect(first.find("[data-test='rule-rank']").text()).toBe("1");
  });

  it("shows the empty state, and an error with retry", async () => {
    const fake = fakeApi({
      "GET /api/rules": new Reply(500, { error: "database is locked" }),
    });
    const wrapper = await mountPage(fake);
    expect(wrapper.find(".error-state").text()).toContain("database is locked");
    fake.on("GET /api/rules", { rows: [] });
    await wrapper.find(".error-state button").trigger("click");
    await flush();
    expect(wrapper.find(".empty-state").text()).toContain("No custom rules");
  });
});

describe("RulesPage: ordering", () => {
  it("moves a rule with the keyboard buttons and PUTs the new order", async () => {
    const fake = pageApi();
    const wrapper = await mountPage(fake);
    const rows = wrapper.findAll("[data-test='custom-rule']");
    expect(rows[0]!.find("[data-test='rule-up']").attributes("disabled")).toBeDefined();
    await rows[0]!.find("[data-test='rule-down']").trigger("click");
    await flush();
    expect(fake.callsTo("PUT /api/rules/order")[0]?.body).toEqual({ ids: [3, 2, 4, 5, 6, 7, 8] });
    expect(names(wrapper)[0]).toBe("Expire: watched after 2 months");
    await wrapper
      .findAll("[data-test='custom-rule']")[6]!
      .find("[data-test='rule-up']")
      .trigger("click");
    await flush();
    expect(fake.callsTo("PUT /api/rules/order")[1]?.body).toEqual({ ids: [3, 2, 4, 5, 6, 8, 7] });
  });

  it("reorders by drag and drop", async () => {
    const fake = pageApi();
    const wrapper = await mountPage(fake);
    const rows = wrapper.findAll("[data-test='custom-rule']");
    await rows[6]!.trigger("dragstart");
    await rows[1]!.trigger("dragover");
    expect(rows[1]!.classes()).toContain("rules-page__row--over");
    await rows[1]!.trigger("drop");
    await rows[6]!.trigger("dragend");
    await flush();
    expect(fake.callsTo("PUT /api/rules/order")[0]?.body).toEqual({ ids: [2, 8, 3, 4, 5, 6, 7] });
    expect(names(wrapper)[1]).toBe("Notify when a video goes gone");
    // A drop without a drag in progress does nothing.
    await wrapper.findAll("[data-test='custom-rule']")[0]!.trigger("drop");
    await flush();
    expect(fake.callsTo("PUT /api/rules/order")).toHaveLength(1);
  });

  it("reverts the order when saving it fails", async () => {
    const fake = pageApi();
    fake.on("PUT /api/rules/order", new Reply(409, { error: "stale order" }));
    const wrapper = await mountPage(fake);
    const before = names(wrapper);
    await wrapper
      .findAll("[data-test='custom-rule']")[0]!
      .find("[data-test='rule-down']")
      .trigger("click");
    await flush();
    expect(names(wrapper)).toEqual(before);
  });

  it("keeps the global rule when the order response lists only custom rules", async () => {
    const fake = pageApi();
    fake.on("PUT /api/rules/order", (call: { body: unknown }) => ({
      rows: renumbered(defaultRows(), (call.body as { ids: number[] }).ids).filter(
        (row) => row.kind === "custom",
      ),
    }));
    const wrapper = await mountPage(fake);
    await wrapper
      .findAll("[data-test='custom-rule']")[0]!
      .find("[data-test='rule-down']")
      .trigger("click");
    await flush();
    expect(wrapper.find("[data-test='global-rule']").exists()).toBe(true);
    expect(names(wrapper)[0]).toBe("Expire: watched after 2 months");
  });
});

describe("RulesPage: mutations", () => {
  it("enables and disables a rule with a full PUT", async () => {
    const fake = pageApi();
    fake.on("PUT /api/rules/7", (call: { body: unknown }) => ({
      ...defaultRows()[6]!,
      ...(call.body as object),
    }));
    const wrapper = await mountPage(fake);
    const row = wrapper.findAll("[data-test='custom-rule']")[5]!;
    byTest(row, "rule-toggle").vm.$emit("update:modelValue", false);
    await flush();
    const body = fake.callsTo("PUT /api/rules/7")[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ kind: "custom", enabled: false, position: 6 });
    expect(body["condition"]).toEqual(defaultRows()[6]!.condition);
    expect(
      wrapper.findAll("[data-test='custom-rule']")[5]!.find(".rule-item--disabled").exists(),
    ).toBe(true);
  });

  it("keeps the toggle when the PUT fails", async () => {
    const fake = pageApi();
    fake.on("PUT /api/rules/1", new Reply(500, { error: "nope" }));
    const wrapper = await mountPage(fake);
    wrapper
      .find("[data-test='global-rule']")
      .findAllComponents("[data-test='rule-toggle']")[0]!
      .vm.$emit("update:modelValue", false);
    await flush();
    expect(fake.callsTo("PUT /api/rules/1")).toHaveLength(1);
    expect(wrapper.find("[data-test='global-rule'] .rule-item--disabled").exists()).toBe(false);
  });

  it("duplicates a rule at the end of the list", async () => {
    const fake = pageApi();
    fake.on("POST /api/rules", (call: { body: unknown }) => ({
      ...makeRow({ id: 99 }),
      ...(call.body as object),
    }));
    const wrapper = await mountPage(fake);
    await wrapper.findAll("[data-test='rule-duplicate']")[0]!.trigger("click");
    await flush();
    expect(fake.callsTo("POST /api/rules")[0]?.body).toMatchObject({
      name: "Expire: subscriptions after 2 weeks (copy)",
      position: 8,
      kind: "custom",
    });
    expect(fake.callsTo("GET /api/rules")).toHaveLength(2);
  });

  it("reports a failed duplicate", async () => {
    const fake = pageApi();
    fake.on("POST /api/rules", new Reply(400, { error: "bad" }));
    const wrapper = await mountPage(fake);
    await wrapper.findAll("[data-test='rule-duplicate']")[0]!.trigger("click");
    await flush();
    expect(fake.callsTo("GET /api/rules")).toHaveLength(1);
  });

  it("deletes a rule after confirmation", async () => {
    const fake = pageApi();
    fake.on("DELETE /api/rules/8", new Reply(204));
    const wrapper = await mountPage(fake);
    await wrapper.findAll("[data-test='rule-delete']")[6]!.trigger("click");
    await flush();
    expect(wrapper.text()).toContain("Delete the rule 'Notify when a video goes gone'?");
    const confirm = wrapper.findAll(".p-dialog button").find((b) => b.text() === "Delete");
    await confirm!.trigger("click");
    await flush();
    expect(fake.callsTo("DELETE /api/rules/8")).toHaveLength(1);
    expect(names(wrapper)).not.toContain("Notify when a video goes gone");
  });

  it("keeps the rule when the delete fails, and cancels cleanly", async () => {
    const fake = pageApi();
    fake.on("DELETE /api/rules/8", new Reply(404, { error: "gone" }));
    const wrapper = await mountPage(fake);
    await wrapper.findAll("[data-test='rule-delete']")[6]!.trigger("click");
    await flush();
    const confirm = wrapper.findAll(".p-dialog button").find((b) => b.text() === "Delete");
    await confirm!.trigger("click");
    await flush();
    expect(names(wrapper)).toContain("Notify when a video goes gone");
    await wrapper
      .findAll(".p-dialog button")
      .find((b) => b.text() === "Cancel")!
      .trigger("click");
    await flush();
    expect(wrapper.text()).not.toContain("Delete the rule");
  });
});

describe("RulesPage: editor", () => {
  it("creates a rule from the drawer", async () => {
    const fake = pageApi();
    fake.on("POST /api/rules", (call: { body: unknown }) => ({
      ...makeRow({ id: 70 }),
      ...(call.body as object),
    }));
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-test='new-rule']").trigger("click");
    await flush();
    const editor = wrapper.findComponent(RuleEditor);
    expect(editor.exists()).toBe(true);
    expect(wrapper.find("[data-test='name-error']").exists()).toBe(true);
    expect(wrapper.find("[data-test='rule-save']").attributes("disabled")).toBeDefined();
    await wrapper
      .find("[data-test='rule-name'] input, input[data-test='rule-name']")
      .setValue("Big videos");
    await wrapper.find("[data-test='add-leaf']").trigger("click");
    await flush();
    await wrapper.find("form[data-test='rule-editor']").trigger("submit");
    await flush();
    const body = fake.callsTo("POST /api/rules")[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      kind: "custom",
      name: "Big videos",
      enabled: true,
      position: 8,
      video_id: null,
      effects: {},
    });
    expect(body["condition"]).toEqual({
      type: "group",
      op: "and",
      children: [{ type: "cond", field: "title", op: "contains", value: "", ci: true }],
    });
    expect(wrapper.findComponent(RuleEditor).exists()).toBe(false);
    expect(fake.callsTo("GET /api/rules")).toHaveLength(2);
  });

  it("opens the rule named by ?edit= and saves it with a PUT", async () => {
    const fake = pageApi();
    fake.on("PUT /api/rules/1", (call: { body: unknown }) => ({
      ...defaultRows()[0]!,
      ...(call.body as object),
    }));
    const wrapper = await mountPage(fake, "/rules?edit=1");
    expect(wrapper.find("[data-test='global-note']").exists()).toBe(true);
    expect(wrapper.find("[data-test='condition-tree']").exists()).toBe(false);
    expect(wrapper.findComponent(RulePreviewPanel).exists()).toBe(false);
    await wrapper.find("form[data-test='rule-editor']").trigger("submit");
    await flush();
    const body = fake.callsTo("PUT /api/rules/1")[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ kind: "global", condition: null, position: 0 });
    expect(body["effects"]).toEqual(defaultRows()[0]!.effects);
  });

  it("shows a server rejection in the editor and can cancel", async () => {
    const fake = pageApi();
    fake.on("PUT /api/rules/2", new Reply(400, { error: "condition rejected", code: "invalid" }));
    const wrapper = await mountPage(fake);
    await wrapper.findAll("[data-test='rule-edit']")[1]!.trigger("click");
    await flush();
    await wrapper.find("form[data-test='rule-editor']").trigger("submit");
    await flush();
    expect(wrapper.find("[data-test='save-error']").text()).toBe("condition rejected");
    await wrapper.find("[data-test='rule-cancel']").trigger("click");
    await flush();
    expect(wrapper.findComponent(RuleEditor).exists()).toBe(false);
  });

  it("blocks saving while the condition is invalid", async () => {
    const fake = pageApi([
      makeRow({
        id: 2,
        condition: {
          type: "group",
          op: "and",
          children: [{ type: "cond", field: "views", op: "between", value: [9, 1] }],
        },
      }),
    ]);
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-test='rule-name']").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='leaf-error']").exists()).toBe(true);
    expect(wrapper.find("[data-test='preview-invalid']").exists()).toBe(true);
    expect(wrapper.find("[data-test='rule-save']").attributes("disabled")).toBeDefined();
    await wrapper.find("form[data-test='rule-editor']").trigger("submit");
    await flush();
    expect(fake.callsTo("PUT /api/rules/2")).toHaveLength(0);
  });
});

describe("RulePreviewPanel", () => {
  const condition = {
    type: "group" as const,
    op: "and" as const,
    children: [{ type: "cond" as const, field: "views" as const, op: "gt" as const, value: 1 }],
  };

  it("waits 400 ms after the last change before asking, and shows the result", async () => {
    vi.useFakeTimers();
    const fake = fakeApi({
      "POST /api/rules/preview": {
        count: 2,
        total: 1234,
        sample: [
          { id: "aaaaaaaaaaa", title: "First match", channel_title: "Chan" },
          { id: "bbbbbbbbbbb", title: "Second match", channel_title: null },
        ],
      },
    });
    const wrapper = mount(RulePreviewPanel, {
      props: { condition, valid: true },
      global: mountGlobals({ api: fake.api }),
    });
    await vi.advanceTimersByTimeAsync(200);
    await wrapper.setProps({ condition: { ...condition, op: "or" as const } });
    await vi.advanceTimersByTimeAsync(399);
    expect(fake.callsTo("POST /api/rules/preview")).toHaveLength(0);
    expect(wrapper.find("[data-test='preview-loading']").exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    expect(fake.callsTo("POST /api/rules/preview")).toHaveLength(1);
    expect(fake.callsTo("POST /api/rules/preview")[0]?.body).toEqual({
      condition: { ...condition, op: "or" },
    });
    expect(wrapper.find("[data-test='preview-count']").text()).toBe("Matches 2 of 1,234 videos");
    expect(wrapper.findAll("[data-test='preview-sample']").map((li) => li.text())).toEqual([
      "First match - Chan",
      "Second match",
    ]);
  });

  it("does not ask while invalid, and shows request errors", async () => {
    vi.useFakeTimers();
    const fake = fakeApi({ "POST /api/rules/preview": new Reply(500, { error: "eval failed" }) });
    const wrapper = mount(RulePreviewPanel, {
      props: { condition, valid: false },
      global: mountGlobals({ api: fake.api }),
    });
    await vi.runAllTimersAsync();
    expect(fake.calls).toHaveLength(0);
    expect(wrapper.find("[data-test='preview-invalid']").exists()).toBe(true);
    await wrapper.setProps({ valid: true });
    await vi.runAllTimersAsync();
    expect(wrapper.find("[data-test='preview-error']").text()).toBe("eval failed");
    wrapper.unmount();
  });

  it("aborts a request an edit made stale", async () => {
    vi.useFakeTimers();
    let release: (() => void) | null = null;
    const fake = fakeApi({
      "POST /api/rules/preview": () =>
        new Promise((resolve) => {
          release = () => resolve({ count: 1, total: 1, sample: [] });
        }),
    });
    const wrapper = mount(RulePreviewPanel, {
      props: { condition, valid: true },
      global: mountGlobals({ api: fake.api }),
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(fake.calls).toHaveLength(1);
    await wrapper.setProps({ condition: { ...condition, not: true } });
    (release as (() => void) | null)?.();
    await vi.runAllTimersAsync();
    expect(fake.calls).toHaveLength(2);
    expect(wrapper.find("[data-test='preview-error']").exists()).toBe(false);
  });
});
