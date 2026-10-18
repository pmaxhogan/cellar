import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import Checkbox from "primevue/checkbox";
import InputNumber from "primevue/inputnumber";
import Select from "primevue/select";
import ToggleSwitch from "primevue/toggleswitch";
import { THUMBNAIL_VARIANTS, settingGroups, type SettingKey } from "@cellar/shared";
import SettingsPage from "../../src/pages/SettingsPage.vue";
import SettingField from "../../src/components/settings/SettingField.vue";
import type { Overrides } from "../../src/api/settings.ts";
import { flush } from "../helpers/dom.ts";
import {
  apiError,
  captureToasts,
  fakeServer,
  json,
  type CapturedToast,
  type FakeServer,
} from "../helpers/adminFetch.ts";
import { mountGlobals } from "../helpers/mount.ts";

let toasts: CapturedToast[];

beforeEach(() => {
  toasts = captureToasts();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A server that stores overrides and applies PUT patches like the real one. */
function settingsServer(initial: Overrides = {}): FakeServer & { stored: () => Overrides } {
  let stored: Overrides = { ...initial };
  const server = fakeServer({
    "GET /api/settings": () => ({ overrides: stored }),
    "PUT /api/settings": (call) => {
      const next = { ...stored };
      for (const [key, value] of Object.entries(call.body as Overrides)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      stored = next;
      return { overrides: stored };
    },
  });
  return { ...server, stored: () => stored };
}

async function mountPage(server: FakeServer): Promise<VueWrapper> {
  const wrapper = mount(SettingsPage, { global: mountGlobals({ api: server.api }) });
  await flush();
  return wrapper;
}

function field(wrapper: VueWrapper, key: SettingKey): VueWrapper {
  const found = wrapper
    .findAllComponents(SettingField)
    .find((candidate) => candidate.props("settingKey") === key);
  if (found === undefined) throw new Error(`no field for ${key}`);
  return found as VueWrapper;
}

async function setNumber(wrapper: VueWrapper, key: SettingKey, value: number | null) {
  field(wrapper, key).findComponent(InputNumber).vm.$emit("update:modelValue", value);
  await flush(1);
}

async function save(wrapper: VueWrapper): Promise<void> {
  await wrapper.find("[data-action='save']").trigger("click");
  await flush();
}

function putBodies(server: FakeServer): unknown[] {
  return server.callsTo("PUT /api/settings").map((call) => call.body);
}

describe("SettingsPage rendering", () => {
  it("renders every registry group and key with resolved values", async () => {
    const server = settingsServer({ "download.concurrency": 4 });
    const wrapper = await mountPage(server);
    const groups = wrapper.findAll(".settings-group");
    expect(groups.map((group) => group.find("h2").text())).toEqual(
      settingGroups().map((group) => group.group),
    );
    expect(wrapper.findAllComponents(SettingField)).toHaveLength(
      settingGroups().reduce((sum, group) => sum + group.keys.length, 0),
    );

    const concurrency = field(wrapper, "download.concurrency");
    expect(concurrency.findComponent(InputNumber).props("modelValue")).toBe(4);
    expect(concurrency.find("[data-test='modified']").exists()).toBe(true);
    expect(concurrency.find("[data-test='default']").text()).toBe("Default: 2 downloads");
    expect(concurrency.text()).toContain("How many yt-dlp downloads may run at the same time.");
    expect(concurrency.text()).toContain("downloads");
    expect(concurrency.find("[data-action='reset']").exists()).toBe(true);

    const evalInterval = field(wrapper, "eval.interval_minutes");
    expect(evalInterval.findComponent(InputNumber).props("modelValue")).toBe(60);
    expect(evalInterval.find("[data-test='modified']").exists()).toBe(false);
    expect(evalInterval.find("[data-action='reset']").exists()).toBe(false);

    expect(wrapper.find("[data-action='save']").attributes("disabled")).toBeDefined();
    expect(wrapper.find("[data-action='discard']").attributes("disabled")).toBeDefined();
  });

  it("renders each control kind", async () => {
    const wrapper = await mountPage(settingsServer());
    expect(field(wrapper, "recheck.ryd_enabled").findComponent(ToggleSwitch).exists()).toBe(true);
    expect(field(wrapper, "tools.js_runtime").findComponent(Select).props("modelValue")).toBe(
      "node",
    );
    expect(
      (field(wrapper, "tools.pot_provider_url").find("input").element as HTMLInputElement).value,
    ).toBe("http://bgutil:4416");
    expect(field(wrapper, "thumbnails.variants").findAllComponents(Checkbox)).toHaveLength(
      THUMBNAIL_VARIANTS.length,
    );
    const rate = field(wrapper, "download.rate_limit_bytes_per_s");
    expect(rate.find("[data-test='null-switch']").exists()).toBe(true);
    expect(rate.findComponent(InputNumber).exists()).toBe(false);
    expect(rate.text()).toContain("No limit");
    // Fractional settings allow decimals, integer ones do not.
    expect(
      field(wrapper, "reaper.min_free_gb").findComponent(InputNumber).props("maxFractionDigits"),
    ).toBe(3);
    expect(
      field(wrapper, "download.concurrency").findComponent(InputNumber).props("maxFractionDigits"),
    ).toBe(0);
  });

  it("shows an error state and retries", async () => {
    let calls = 0;
    const server = fakeServer({
      "GET /api/settings": () => {
        calls += 1;
        return calls === 1 ? apiError(500, "db down") : { overrides: {} };
      },
    });
    const wrapper = await mountPage(server);
    expect(wrapper.find(".error-state h2").text()).toBe("Could not load settings");
    expect(wrapper.findAllComponents(SettingField)).toHaveLength(0);
    await wrapper.find(".error-state button").trigger("click");
    await flush();
    expect(wrapper.findAllComponents(SettingField).length).toBeGreaterThan(0);
  });
});

describe("SettingsPage editing", () => {
  it("tracks dirty state and discards", async () => {
    const server = settingsServer();
    const wrapper = await mountPage(server);
    await setNumber(wrapper, "eval.interval_minutes", 15);
    expect(field(wrapper, "eval.interval_minutes").find("[data-test='unsaved']").exists()).toBe(
      true,
    );
    expect(wrapper.find("[data-test='dirty-count']").text()).toBe("1 unsaved change");
    expect(wrapper.find("[data-action='save']").attributes("disabled")).toBeUndefined();
    await wrapper.find("[data-action='discard']").trigger("click");
    await flush(1);
    expect(
      field(wrapper, "eval.interval_minutes").findComponent(InputNumber).props("modelValue"),
    ).toBe(60);
    expect(wrapper.find("[data-test='dirty-count']").exists()).toBe(false);
  });

  it("saves only the changed keys and marks them modified", async () => {
    const server = settingsServer();
    const wrapper = await mountPage(server);
    await setNumber(wrapper, "eval.interval_minutes", 15);
    field(wrapper, "recheck.ryd_enabled")
      .findComponent(ToggleSwitch)
      .vm.$emit("update:modelValue", false);
    field(wrapper, "tools.js_runtime").findComponent(Select).vm.$emit("update:modelValue", "deno");
    await flush(1);
    await save(wrapper);
    expect(putBodies(server)).toEqual([
      { "eval.interval_minutes": 15, "recheck.ryd_enabled": false, "tools.js_runtime": "deno" },
    ]);
    expect(field(wrapper, "eval.interval_minutes").find("[data-test='modified']").exists()).toBe(
      true,
    );
    expect(wrapper.find("[data-test='dirty-count']").exists()).toBe(false);
    expect(toasts).toContainEqual(
      expect.objectContaining({ summary: "Settings saved", detail: "3 settings changed." }),
    );
  });

  it("resets a key to its default by sending null", async () => {
    const server = settingsServer({ "download.concurrency": 4 });
    const wrapper = await mountPage(server);
    await field(wrapper, "download.concurrency").find("[data-action='reset']").trigger("click");
    await flush(1);
    const concurrency = field(wrapper, "download.concurrency");
    expect(concurrency.findComponent(InputNumber).props("modelValue")).toBe(2);
    expect(concurrency.find("[data-test='modified']").exists()).toBe(false);
    expect(concurrency.find("[data-test='unsaved']").exists()).toBe(true);
    await save(wrapper);
    expect(putBodies(server)).toEqual([{ "download.concurrency": null }]);
    expect(server.stored()).toEqual({});
  });

  it("resets an override that already equals the default", async () => {
    const server = settingsServer({ "download.concurrency": 2 });
    const wrapper = await mountPage(server);
    await field(wrapper, "download.concurrency").find("[data-action='reset']").trigger("click");
    await flush(1);
    await save(wrapper);
    expect(putBodies(server)).toEqual([{ "download.concurrency": null }]);
  });

  it("an edit after a reset is sent as a value", async () => {
    const server = settingsServer({ "download.concurrency": 4 });
    const wrapper = await mountPage(server);
    await field(wrapper, "download.concurrency").find("[data-action='reset']").trigger("click");
    await setNumber(wrapper, "download.concurrency", 6);
    await save(wrapper);
    expect(putBodies(server)).toEqual([{ "download.concurrency": 6 }]);
  });

  it("resets an unsaved edit without an override locally", async () => {
    const server = settingsServer();
    const wrapper = await mountPage(server);
    await setNumber(wrapper, "eval.interval_minutes", 15);
    await field(wrapper, "eval.interval_minutes").find("[data-action='reset']").trigger("click");
    await flush(1);
    expect(wrapper.find("[data-test='dirty-count']").exists()).toBe(false);
  });

  it("edits the thumbnail variant list", async () => {
    const server = settingsServer();
    const wrapper = await mountPage(server);
    const boxes = field(wrapper, "thumbnails.variants").findAllComponents(Checkbox);
    boxes[0]!.vm.$emit("update:modelValue", false);
    await flush(1);
    boxes[5]!.vm.$emit("update:modelValue", false);
    await flush(1);
    boxes[5]!.vm.$emit("update:modelValue", true);
    await flush(1);
    await save(wrapper);
    expect(putBodies(server)).toEqual([
      { "thumbnails.variants": ["sddefault", "hqdefault", "mqdefault", "default", "hq720"] },
    ]);
  });

  it("edits the text setting", async () => {
    const server = settingsServer();
    const wrapper = await mountPage(server);
    await field(wrapper, "tools.pot_provider_url").find("input").setValue("");
    await save(wrapper);
    expect(putBodies(server)).toEqual([{ "tools.pot_provider_url": "" }]);
  });
});

describe("SettingsPage nullable rate limit", () => {
  it("switches the limit on and sends a number", async () => {
    const server = settingsServer();
    const wrapper = await mountPage(server);
    const rate = () => field(wrapper, "download.rate_limit_bytes_per_s");
    rate().findAllComponents(ToggleSwitch)[0]!.vm.$emit("update:modelValue", false);
    await flush(1);
    expect(rate().findComponent(InputNumber).exists()).toBe(true);
    await save(wrapper);
    expect(putBodies(server)).toEqual([]);
    expect(rate().find("[data-test='error']").text()).toBe(
      "Enter a value, or switch No limit back on.",
    );
    expect(toasts).toContainEqual(
      expect.objectContaining({ severity: "warn", summary: "Not saved" }),
    );
    await setNumber(wrapper, "download.rate_limit_bytes_per_s", 1_048_576);
    expect(rate().find("[data-test='error']").exists()).toBe(false);
    expect(rate().find("[data-test='bytes-hint']").text()).toBe("1.00 MB/s");
    await save(wrapper);
    expect(putBodies(server)).toEqual([{ "download.rate_limit_bytes_per_s": 1_048_576 }]);
  });

  it("switching No limit back on clears the override and restores the last number", async () => {
    const server = settingsServer({ "download.rate_limit_bytes_per_s": 500_000 });
    const wrapper = await mountPage(server);
    const rate = () => field(wrapper, "download.rate_limit_bytes_per_s");
    expect(rate().findComponent(InputNumber).props("modelValue")).toBe(500_000);
    rate().findAllComponents(ToggleSwitch)[0]!.vm.$emit("update:modelValue", true);
    await flush(1);
    expect(rate().findComponent(InputNumber).exists()).toBe(false);
    rate().findAllComponents(ToggleSwitch)[0]!.vm.$emit("update:modelValue", false);
    await flush(1);
    expect(rate().findComponent(InputNumber).props("modelValue")).toBe(500_000);
    rate().findAllComponents(ToggleSwitch)[0]!.vm.$emit("update:modelValue", true);
    await flush(1);
    await save(wrapper);
    expect(putBodies(server)).toEqual([{ "download.rate_limit_bytes_per_s": null }]);
  });
});

describe("SettingsPage nullable rate limit, clearing", () => {
  it("clearing the number keeps the limit on and asks for a value", async () => {
    const server = settingsServer({ "download.rate_limit_bytes_per_s": 500_000 });
    const wrapper = await mountPage(server);
    const rate = () => field(wrapper, "download.rate_limit_bytes_per_s");
    await setNumber(wrapper, "download.rate_limit_bytes_per_s", null);
    expect(rate().findComponent(InputNumber).exists()).toBe(true);
    expect(rate().findComponent(InputNumber).props("modelValue")).toBeNull();
    await save(wrapper);
    expect(putBodies(server)).toEqual([]);
    expect(rate().find("[data-test='error']").exists()).toBe(true);
  });
});

describe("SettingsPage validation", () => {
  it("blocks an empty required number instead of resetting it", async () => {
    const server = settingsServer({ "download.concurrency": 4 });
    const wrapper = await mountPage(server);
    await setNumber(wrapper, "download.concurrency", null);
    await save(wrapper);
    expect(putBodies(server)).toEqual([]);
    expect(field(wrapper, "download.concurrency").find("[data-test='error']").text()).toBe(
      "Enter a value.",
    );
    expect(wrapper.find("[data-test='field-errors']").text()).toBe(
      "1 setting need attention before saving.",
    );
    await setNumber(wrapper, "download.concurrency", 3);
    expect(wrapper.find("[data-test='field-errors']").exists()).toBe(false);
  });

  it("reports cross-key and schema errors from the shared validators", async () => {
    const server = settingsServer();
    const wrapper = await mountPage(server);
    await setNumber(wrapper, "reaper.low_water_pct", 97);
    await field(wrapper, "tools.pot_provider_url").find("input").setValue("ftp://x");
    await save(wrapper);
    expect(putBodies(server)).toEqual([]);
    expect(field(wrapper, "reaper.low_water_pct").find("[data-test='error']").text()).toBe(
      "Must be lower than the start-reaping threshold",
    );
    expect(field(wrapper, "tools.pot_provider_url").find("[data-test='error']").text()).toBe(
      "Must be an http(s) URL, or empty to disable",
    );
  });

  it("requires at least one thumbnail variant", async () => {
    const server = settingsServer({ "thumbnails.variants": ["hqdefault"] });
    const wrapper = await mountPage(server);
    field(wrapper, "thumbnails.variants")
      .findAllComponents(Checkbox)[2]!
      .vm.$emit("update:modelValue", false);
    await flush(1);
    await save(wrapper);
    expect(putBodies(server)).toEqual([]);
    expect(field(wrapper, "thumbnails.variants").find("[data-test='error']").exists()).toBe(true);
  });

  it("maps a server 400 onto fields and shows the message", async () => {
    const server = fakeServer({
      "GET /api/settings": () => ({ overrides: {} }),
      "PUT /api/settings": () =>
        json(
          {
            error: "Invalid settings",
            code: "invalid_settings",
            details: { errors: { "eval.interval_minutes": "Too frequent for this instance" } },
          },
          400,
        ),
    });
    const wrapper = await mountPage(server);
    await setNumber(wrapper, "eval.interval_minutes", 2);
    await save(wrapper);
    expect(wrapper.find("[data-test='save-error']").text()).toBe("Invalid settings");
    expect(field(wrapper, "eval.interval_minutes").find("[data-test='error']").text()).toBe(
      "Too frequent for this instance",
    );
    expect(toasts).toContainEqual(
      expect.objectContaining({ severity: "error", summary: "Could not save settings" }),
    );
    expect(wrapper.find("[data-test='dirty-count']").text()).toBe("1 unsaved change");
  });

  it("shows a save failure without field details", async () => {
    const server = fakeServer({
      "GET /api/settings": () => ({ overrides: {} }),
      "PUT /api/settings": () => apiError(503, "Not ready"),
    });
    const wrapper = await mountPage(server);
    await setNumber(wrapper, "eval.interval_minutes", 2);
    await save(wrapper);
    expect(wrapper.find("[data-test='save-error']").text()).toBe("Not ready");
    expect(wrapper.findAll("[data-test='error']")).toHaveLength(0);
  });
});
