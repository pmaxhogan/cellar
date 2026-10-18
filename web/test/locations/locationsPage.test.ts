import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import Dialog from "primevue/dialog";
import InputNumber from "primevue/inputnumber";
import ToggleSwitch from "primevue/toggleswitch";
import type { LocationRow } from "@cellar/shared";
import LocationsPage from "../../src/pages/LocationsPage.vue";
import UsageBar from "../../src/components/locations/UsageBar.vue";
import {
  BYTES_PER_GB,
  bytesToGb,
  containerPathProblem,
  gbToBytes,
  usageSummary,
} from "../../src/api/locations.ts";
import { flush } from "../helpers/dom.ts";
import {
  apiError,
  captureToasts,
  fakeServer,
  noContent,
  type CapturedToast,
  type FakeServer,
} from "../helpers/adminFetch.ts";
import { mountGlobals } from "../helpers/mount.ts";

const GB = BYTES_PER_GB;

function location(overrides: Partial<LocationRow> = {}): LocationRow {
  return {
    id: 1,
    label: "Main",
    container_path: "/media",
    quota_bytes: 500 * GB,
    enabled: true,
    used_bytes: 125 * GB,
    fs_free_bytes: 900 * GB,
    mounted: true,
    created_at: 1,
    updated_at: 1,
    ...overrides,
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
  const wrapper = mount(LocationsPage, { global: mountGlobals({ api: server.api }) });
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

const card = (wrapper: VueWrapper, id: number) => wrapper.find(`[data-location='${id}']`);

describe("usage math", () => {
  it("computes the share of quota used and its tone", () => {
    expect(usageSummary(125, 500)).toEqual({ percent: 25, barPercent: 25, tone: "ok" });
    expect(usageSummary(460, 500).tone).toBe("warn");
    expect(usageSummary(475, 500).tone).toBe("danger");
    expect(usageSummary(600, 500)).toEqual({ percent: 120, barPercent: 100, tone: "danger" });
    expect(usageSummary(10, 0)).toEqual({ percent: null, barPercent: 0, tone: "ok" });
    expect(usageSummary(80, 100, 80, 50).tone).toBe("danger");
  });

  it("converts GB both ways, 1024-based", () => {
    expect(gbToBytes(1)).toBe(1_073_741_824);
    expect(gbToBytes(1.5)).toBe(1_610_612_736);
    expect(bytesToGb(500 * GB)).toBe(500);
    expect(bytesToGb(1_000_000_000)).toBe(0.93);
  });

  it("validates container paths", () => {
    expect(containerPathProblem("")).toContain("Enter the path");
    expect(containerPathProblem("media2")).toContain("absolute");
    expect(containerPathProblem("/")).toContain("root");
    expect(containerPathProblem("/data")).toContain("/data");
    expect(containerPathProblem("/data/x")).toContain("/data");
    expect(containerPathProblem(" /media2 ")).toBeNull();
    expect(containerPathProblem("/database")).toBeNull();
  });

  it("renders the bar, the numbers and the filesystem free space", () => {
    const wrapper = mount(UsageBar, {
      props: { used: 475 * GB, quota: 500 * GB, fsFree: 20 * GB, fsTotal: 4096 * GB },
    });
    expect(wrapper.find("[data-test='usage-text']").text()).toBe("475 GB of 500 GB quota used");
    expect(wrapper.find("[data-test='usage-percent']").text()).toBe("95.0%");
    expect(wrapper.find("[role='progressbar']").attributes("aria-valuenow")).toBe("95");
    expect(wrapper.find(".usage-bar").classes()).toContain("tone-danger");
    expect(wrapper.find("[data-test='usage-free']").text()).toBe(
      "20.0 GB free on the filesystem of 4.00 TB",
    );
  });

  it("handles no quota and unknown free space", () => {
    const wrapper = mount(UsageBar, { props: { used: 0, quota: 0, fsFree: null } });
    expect(wrapper.find("[data-test='usage-percent']").text()).toBe("no quota");
    expect(wrapper.find("[data-test='usage-free']").text()).toBe("Filesystem free space unknown");
  });
});

describe("LocationsPage", () => {
  it("renders a card per location", async () => {
    const server = fakeServer({
      "GET /api/locations": () => ({
        rows: [location(), location({ id: 2, label: "Cold", enabled: false, mounted: false })],
      }),
    });
    const wrapper = await mountPage(server);
    expect(wrapper.findAll(".location-card")).toHaveLength(2);
    const main = card(wrapper, 1);
    expect(main.find("h2").text()).toBe("Main");
    expect(main.find("[data-fact='path']").text()).toBe("/media");
    expect(main.find("[data-fact='enabled']").text()).toBe("Enabled");
    expect(main.find("[data-fact='mounted']").text()).toBe("Mounted");
    expect(main.find("[data-test='usage-text']").text()).toBe("125 GB of 500 GB quota used");
    expect(main.find("[data-test='usage-percent']").text()).toBe("25.0%");
    expect(main.find("[data-test='usage-free']").text()).toBe("900 GB free on the filesystem");
    const cold = card(wrapper, 2);
    expect(cold.find("[data-fact='enabled']").text()).toBe("Disabled");
    expect(cold.find("[data-fact='mounted']").text()).toBe("Not mounted");
    expect(cold.find("[data-action='toggle']").text()).toBe("Enable");
  });

  it("shows the empty state", async () => {
    const server = fakeServer({ "GET /api/locations": () => ({ rows: [] }) });
    const wrapper = await mountPage(server);
    expect(wrapper.find(".empty-state h2").text()).toBe("No storage locations");
  });

  it("shows an error state and retries", async () => {
    let calls = 0;
    const server = fakeServer({
      "GET /api/locations": () => {
        calls += 1;
        return calls === 1 ? apiError(500, "db locked") : { rows: [location()] };
      },
    });
    const wrapper = await mountPage(server);
    expect(wrapper.find(".error-state h2").text()).toBe("Could not load locations");
    await wrapper.find(".error-state button").trigger("click");
    await flush();
    expect(wrapper.findAll(".location-card")).toHaveLength(1);
  });

  it("refreshes usage and shows the filesystem total", async () => {
    const server = fakeServer({
      "GET /api/locations": () => ({ rows: [location()] }),
      "GET /api/locations/1/usage": () => ({
        used_bytes: 250 * GB,
        fs_free_bytes: 800 * GB,
        fs_total_bytes: 2048 * GB,
        quota_bytes: 500 * GB,
        mounted: true,
      }),
    });
    const wrapper = await mountPage(server);
    await card(wrapper, 1).find("[data-action='refresh']").trigger("click");
    await flush();
    expect(card(wrapper, 1).find("[data-test='usage-percent']").text()).toBe("50.0%");
    expect(card(wrapper, 1).find("[data-test='usage-free']").text()).toBe(
      "800 GB free on the filesystem of 2.00 TB",
    );
  });

  it("toasts a failed usage refresh", async () => {
    const server = fakeServer({
      "GET /api/locations": () => ({ rows: [location()] }),
      "GET /api/locations/1/usage": () => apiError(500, "statfs failed"),
    });
    const wrapper = await mountPage(server);
    await card(wrapper, 1).find("[data-action='refresh']").trigger("click");
    await flush();
    expect(toasts).toContainEqual(expect.objectContaining({ detail: "statfs failed" }));
  });

  it("enables and disables", async () => {
    const server = fakeServer({
      "GET /api/locations": () => ({ rows: [location()] }),
      "PUT /api/locations/1": () => location({ enabled: false }),
    });
    const wrapper = await mountPage(server);
    await card(wrapper, 1).find("[data-action='toggle']").trigger("click");
    await flush();
    expect(server.callsTo("PUT /api/locations/1")[0]!.body).toEqual({ enabled: false });
    expect(card(wrapper, 1).find("[data-fact='enabled']").text()).toBe("Disabled");
    expect(toasts).toContainEqual(expect.objectContaining({ summary: "Location disabled" }));
  });

  it("toasts a failed toggle", async () => {
    const server = fakeServer({
      "GET /api/locations": () => ({ rows: [location()] }),
      "PUT /api/locations/1": () => apiError(400, "bad"),
    });
    const wrapper = await mountPage(server);
    await card(wrapper, 1).find("[data-action='toggle']").trigger("click");
    await flush();
    expect(toasts).toContainEqual(expect.objectContaining({ severity: "error", detail: "bad" }));
  });

  it("adds a location, explaining the bind mount, with the quota in bytes", async () => {
    const server = fakeServer({
      "GET /api/locations": () => ({ rows: [] }),
      "POST /api/locations": (call) => location({ id: 5, ...(call.body as object) }),
    });
    const wrapper = await mountPage(server);
    await wrapper.find("[data-action='add-location']").trigger("click");
    await flush();
    const note = wrapper.find("[data-test='mount-note']");
    expect(note.text()).toContain("bind mount");
    expect(note.find("a").attributes("href")).toContain(
      "deploy/README.md#adding-a-second-storage-location",
    );

    await dialogButton(wrapper, "Add location").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='path-error']").exists()).toBe(true);
    expect(wrapper.find("[data-test='quota-error']").exists()).toBe(true);
    expect(server.callsTo("POST /api/locations")).toHaveLength(0);

    await wrapper.find("#location-label").setValue("Cold storage");
    await wrapper.find("#location-path").setValue("/data/media");
    expect(wrapper.find("[data-test='path-error']").text()).toContain("/data");
    await wrapper.find("#location-path").setValue(" /media2 ");
    wrapper.findComponent(InputNumber).vm.$emit("update:modelValue", 1.5);
    await flush();
    expect(wrapper.find("[data-test='quota-preview']").text()).toContain("1.50 GB");
    wrapper.findComponent(ToggleSwitch).vm.$emit("update:modelValue", false);
    await dialogButton(wrapper, "Add location").trigger("click");
    await flush();
    expect(server.callsTo("POST /api/locations")[0]!.body).toEqual({
      label: "Cold storage",
      container_path: "/media2",
      quota_bytes: 1_610_612_736,
      enabled: false,
    });
    expect(card(wrapper, 5).find("h2").text()).toBe("Cold storage");
    expect(wrapper.find("#location-label").exists()).toBe(false);
  });

  it("edits label and quota with the path fixed", async () => {
    const server = fakeServer({
      "GET /api/locations": () => ({ rows: [location()] }),
      "PUT /api/locations/1": (call) => location({ ...(call.body as object) }),
    });
    const wrapper = await mountPage(server);
    await card(wrapper, 1).find("[data-action='edit']").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='mount-note']").exists()).toBe(false);
    expect(wrapper.find("#location-path").attributes("disabled")).toBeDefined();
    expect(wrapper.findComponent(InputNumber).props("modelValue")).toBe(500);
    await wrapper.find("#location-label").setValue("Primary");
    wrapper.findComponent(InputNumber).vm.$emit("update:modelValue", 750);
    await dialogButton(wrapper, "Save").trigger("click");
    await flush();
    expect(server.callsTo("PUT /api/locations/1")[0]!.body).toEqual({
      label: "Primary",
      quota_bytes: 750 * GB,
      enabled: true,
    });
    expect(card(wrapper, 1).find("[data-test='usage-text']").text()).toBe(
      "125 GB of 750 GB quota used",
    );
  });

  it("leaves an untouched odd quota alone on edit", async () => {
    const server = fakeServer({
      "GET /api/locations": () => ({ rows: [location({ quota_bytes: 1_000_000_000 })] }),
      "PUT /api/locations/1": () => location({ quota_bytes: 1_000_000_000 }),
    });
    const wrapper = await mountPage(server);
    await card(wrapper, 1).find("[data-action='edit']").trigger("click");
    await flush();
    expect(wrapper.findComponent(InputNumber).props("modelValue")).toBe(0.93);
    await dialogButton(wrapper, "Save").trigger("click");
    await flush();
    expect(server.callsTo("PUT /api/locations/1")[0]!.body).toEqual({
      label: "Main",
      enabled: true,
    });
  });

  it("shows a save failure in the dialog", async () => {
    const server = fakeServer({
      "GET /api/locations": () => ({ rows: [location()] }),
      "PUT /api/locations/1": () => apiError(400, "Quota below used space"),
    });
    const wrapper = await mountPage(server);
    await card(wrapper, 1).find("[data-action='edit']").trigger("click");
    await flush();
    await dialogButton(wrapper, "Save").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='location-form-error']").text()).toBe("Quota below used space");
  });

  it("deletes after confirmation", async () => {
    const server = fakeServer({
      "GET /api/locations": () => ({ rows: [location(), location({ id: 2, label: "Old" })] }),
      "DELETE /api/locations/2": () => noContent(),
    });
    const wrapper = await mountPage(server);
    await card(wrapper, 2).find("[data-action='remove']").trigger("click");
    await flush();
    expect(wrapper.find(".confirm-message").text()).toContain("Unregister Old");
    await dialogButton(wrapper, "Delete").trigger("click");
    await flush();
    expect(card(wrapper, 2).exists()).toBe(false);
  });

  it("explains a 409 when the location still holds media", async () => {
    const server = fakeServer({
      "GET /api/locations": () => ({ rows: [location()] }),
      "DELETE /api/locations/1": () => apiError(409, "Location has media", "location_in_use"),
    });
    const wrapper = await mountPage(server);
    await card(wrapper, 1).find("[data-action='remove']").trigger("click");
    await flush();
    await dialogButton(wrapper, "Delete").trigger("click");
    await flush();
    expect(card(wrapper, 1).exists()).toBe(true);
    expect(toasts).toContainEqual(
      expect.objectContaining({ severity: "warn", summary: "Location still holds media" }),
    );
  });

  it("toasts other delete failures", async () => {
    const server = fakeServer({
      "GET /api/locations": () => ({ rows: [location()] }),
      "DELETE /api/locations/1": () => apiError(500, "boom"),
    });
    const wrapper = await mountPage(server);
    await card(wrapper, 1).find("[data-action='remove']").trigger("click");
    await flush();
    await dialogButton(wrapper, "Delete").trigger("click");
    await flush();
    expect(toasts).toContainEqual(expect.objectContaining({ severity: "error", detail: "boom" }));
    await dialogButton(wrapper, "Cancel").trigger("click");
    await flush();
    expect(wrapper.find(".confirm-message").exists()).toBe(false);
  });
});

function openDialog(wrapper: VueWrapper) {
  const found = wrapper.findAllComponents(Dialog).find((dialog) => dialog.props("visible"));
  if (found === undefined) throw new Error("no open dialog");
  return found;
}

describe("LocationsPage dialog closing and cleanup", () => {
  it("opens from the empty state and closes from the header and Cancel", async () => {
    const server = fakeServer({ "GET /api/locations": () => ({ rows: [] }) });
    const wrapper = await mountPage(server);
    await wrapper.find(".empty-state button").trigger("click");
    await flush();
    openDialog(wrapper).vm.$emit("update:visible", false);
    await flush();
    expect(wrapper.find("#location-label").exists()).toBe(false);
    await wrapper.find("[data-action='add-location']").trigger("click");
    await flush();
    await dialogButton(wrapper, "Cancel").trigger("click");
    await flush();
    expect(wrapper.find("#location-label").exists()).toBe(false);
  });

  it("aborts an in-flight load on unmount", async () => {
    const server = fakeServer({ "GET /api/locations": () => new Promise(() => undefined) });
    const wrapper = await mountPage(server);
    expect(wrapper.find(".list-skeleton").exists()).toBe(true);
    wrapper.unmount();
    expect(server.calls[0]!.signal?.aborted).toBe(true);
  });
});
