import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import Dialog from "primevue/dialog";
import ToggleSwitch from "primevue/toggleswitch";
import type { ProxyRow } from "@cellar/shared";
import ProxiesPage from "../../src/pages/ProxiesPage.vue";
import { describeTest, proxyUrlProblem } from "../../src/api/proxies.ts";
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

const SECRET_URL = "socks5://alice:hunter2@10.0.0.5:1080";

function proxy(overrides: Partial<ProxyRow> = {}): ProxyRow {
  return {
    id: 1,
    label: "Home VPN",
    url_redacted: "socks5://***@10.0.0.5:1080",
    enabled: true,
    fail_count: 0,
    skipped_until: null,
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
  const wrapper = mount(ProxiesPage, { global: mountGlobals({ api: server.api }) });
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

const actions = (wrapper: VueWrapper, id: number) => wrapper.find(`[data-proxy='${id}']`);
const urlInput = (wrapper: VueWrapper) => wrapper.find("#proxy-url");

describe("proxy helpers", () => {
  it("checks the URL shape", () => {
    expect(proxyUrlProblem("")).toBe("Enter the proxy URL.");
    expect(proxyUrlProblem("10.0.0.5:1080")).toContain("scheme://");
    expect(proxyUrlProblem("http://host with space")).toContain("scheme://");
    expect(proxyUrlProblem(" http://proxy:3128 ")).toBeNull();
    expect(proxyUrlProblem(SECRET_URL)).toBeNull();
  });

  it("describes test results", () => {
    expect(describeTest({ ok: true, latency_ms: 123.4 })).toBe("Reachable in 123 ms");
    expect(describeTest({ ok: true, latency_ms: null })).toBe("Reachable");
    expect(describeTest({ ok: false, latency_ms: null, error: "timeout" })).toBe("Failed: timeout");
    expect(describeTest({ ok: false })).toBe("Failed");
  });
});

describe("ProxiesPage list", () => {
  it("renders each proxy with only the redacted URL", async () => {
    const future = Date.now() + 8 * 60_000;
    const server = fakeServer({
      "GET /api/proxies": () => ({
        rows: [
          proxy(),
          proxy({
            id: 2,
            label: "DC",
            url_redacted: "http://***@dc:3128",
            enabled: false,
            fail_count: 4,
            skipped_until: future,
          }),
          proxy({ id: 3, label: "Old skip", skipped_until: Date.now() - 60_000 }),
        ],
      }),
    });
    const wrapper = await mountPage(server);
    const rows = wrapper.findAll("tbody tr");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.text()).toContain("Home VPN");
    expect(rows[0]!.find("[data-test='url-redacted']").text()).toBe("socks5://***@10.0.0.5:1080");
    expect(rows[0]!.find("[data-test='enabled']").text()).toBe("Enabled");
    expect(rows[0]!.find("[data-test='skipped']").text()).toBe("-");
    expect(rows[1]!.find("[data-test='enabled']").text()).toBe("Disabled");
    expect(rows[1]!.find("[data-test='fail-count']").text()).toBe("4");
    expect(rows[1]!.find("[data-test='skipped']").text()).toBe("until in 8 min");
    expect(rows[1]!.find("[data-action='toggle']").text()).toBe("Enable");
    expect(rows[2]!.find("[data-test='skipped']").text()).toBe("-");
  });

  it("shows the empty state", async () => {
    const server = fakeServer({ "GET /api/proxies": () => ({ rows: [] }) });
    const wrapper = await mountPage(server);
    expect(wrapper.find(".empty-state h2").text()).toBe("No proxies");
  });

  it("shows an error state and retries", async () => {
    let calls = 0;
    const server = fakeServer({
      "GET /api/proxies": () => {
        calls += 1;
        return calls === 1 ? apiError(500, "kaput") : { rows: [proxy()] };
      },
    });
    const wrapper = await mountPage(server);
    expect(wrapper.find(".error-state h2").text()).toBe("Could not load proxies");
    await wrapper.find(".error-state button").trigger("click");
    await flush();
    expect(wrapper.findAll("tbody tr")).toHaveLength(1);
  });
});

describe("ProxiesPage actions", () => {
  it("tests a proxy and shows the latency", async () => {
    const server = fakeServer({
      "GET /api/proxies": () => ({ rows: [proxy()] }),
      "POST /api/proxies/1/test": () => ({ ok: true, latency_ms: 87 }),
    });
    const wrapper = await mountPage(server);
    await actions(wrapper, 1).find("[data-action='test']").trigger("click");
    await flush();
    expect(server.callsTo("POST /api/proxies/1/test")).toHaveLength(1);
    expect(wrapper.find("[data-test='test-result']").text()).toBe("Reachable in 87 ms");
    expect(wrapper.find("[data-test='test-result']").classes()).toContain("proxies-ok");
    expect(toasts).toContainEqual(
      expect.objectContaining({ severity: "success", summary: "Home VPN works" }),
    );
  });

  it("shows a failed test and a test request that errors", async () => {
    let calls = 0;
    const server = fakeServer({
      "GET /api/proxies": () => ({ rows: [proxy()] }),
      "POST /api/proxies/1/test": () => {
        calls += 1;
        return calls === 1
          ? { ok: false, latency_ms: null, error: "connection refused" }
          : apiError(500, "tester crashed");
      },
    });
    const wrapper = await mountPage(server);
    await actions(wrapper, 1).find("[data-action='test']").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='test-result']").text()).toBe("Failed: connection refused");
    expect(wrapper.find("[data-test='test-result']").classes()).toContain("proxies-failed");
    expect(toasts).toContainEqual(expect.objectContaining({ severity: "warn" }));
    await actions(wrapper, 1).find("[data-action='test']").trigger("click");
    await flush();
    expect(toasts).toContainEqual(
      expect.objectContaining({ severity: "error", detail: "tester crashed" }),
    );
  });

  it("enables and disables", async () => {
    const server = fakeServer({
      "GET /api/proxies": () => ({ rows: [proxy()] }),
      "PUT /api/proxies/1": () => proxy({ enabled: false }),
    });
    const wrapper = await mountPage(server);
    await actions(wrapper, 1).find("[data-action='toggle']").trigger("click");
    await flush();
    expect(server.callsTo("PUT /api/proxies/1")[0]!.body).toEqual({ enabled: false });
    expect(wrapper.find("[data-test='enabled']").text()).toBe("Disabled");
  });

  it("toasts a failed toggle", async () => {
    const server = fakeServer({
      "GET /api/proxies": () => ({ rows: [proxy()] }),
      "PUT /api/proxies/1": () => apiError(500, "nope"),
    });
    const wrapper = await mountPage(server);
    await actions(wrapper, 1).find("[data-action='toggle']").trigger("click");
    await flush();
    expect(toasts).toContainEqual(expect.objectContaining({ severity: "error", detail: "nope" }));
  });

  it("deletes after confirmation, and toasts a failure", async () => {
    let calls = 0;
    const server = fakeServer({
      "GET /api/proxies": () => ({ rows: [proxy(), proxy({ id: 2, label: "DC" })] }),
      "DELETE /api/proxies/2": () => {
        calls += 1;
        return calls === 1 ? apiError(500, "busy") : noContent();
      },
    });
    const wrapper = await mountPage(server);
    await actions(wrapper, 2).find("[data-action='remove']").trigger("click");
    await flush();
    expect(wrapper.find(".confirm-message").text()).toContain("Delete DC?");
    await dialogButton(wrapper, "Delete").trigger("click");
    await flush();
    expect(toasts).toContainEqual(expect.objectContaining({ detail: "busy" }));
    expect(actions(wrapper, 2).exists()).toBe(true);
    await dialogButton(wrapper, "Delete").trigger("click");
    await flush();
    expect(actions(wrapper, 2).exists()).toBe(false);
    expect(wrapper.find(".confirm-message").exists()).toBe(false);
  });
});

describe("Proxy dialog", () => {
  it("adds a proxy with a password-style URL field", async () => {
    const server = fakeServer({
      "GET /api/proxies": () => ({ rows: [] }),
      "POST /api/proxies": () => proxy({ id: 9, label: "New" }),
    });
    const wrapper = await mountPage(server);
    await wrapper.find("[data-action='add-proxy']").trigger("click");
    await flush();
    expect(urlInput(wrapper).attributes("type")).toBe("password");
    expect(urlInput(wrapper).attributes("autocomplete")).toBe("new-password");

    await dialogButton(wrapper, "Add proxy").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='url-error']").text()).toBe("Enter the proxy URL.");
    expect(server.callsTo("POST /api/proxies")).toHaveLength(0);

    await wrapper.find("#proxy-label").setValue(" New ");
    await urlInput(wrapper).setValue(` ${SECRET_URL} `);
    wrapper.findComponent(ToggleSwitch).vm.$emit("update:modelValue", false);
    await dialogButton(wrapper, "Add proxy").trigger("click");
    await flush();
    expect(server.callsTo("POST /api/proxies")[0]!.body).toEqual({
      label: "New",
      url: SECRET_URL,
      enabled: false,
    });
    expect(actions(wrapper, 9).exists()).toBe(true);
    expect(wrapper.html()).not.toContain("hunter2");
  });

  it("never prefills the URL on edit, and keeps it when left empty", async () => {
    const server = fakeServer({
      "GET /api/proxies": () => ({ rows: [proxy()] }),
      "PUT /api/proxies/1": (call) => proxy({ ...(call.body as object), url_redacted: "x" }),
    });
    const wrapper = await mountPage(server);
    await actions(wrapper, 1).find("[data-action='edit']").trigger("click");
    await flush();
    expect((urlInput(wrapper).element as HTMLInputElement).value).toBe("");
    expect(urlInput(wrapper).attributes("placeholder")).toBe("Leave empty to keep the stored URL");
    expect((wrapper.find("#proxy-label").element as HTMLInputElement).value).toBe("Home VPN");
    await wrapper.find("#proxy-label").setValue("Home");
    await dialogButton(wrapper, "Save").trigger("click");
    await flush();
    expect(server.callsTo("PUT /api/proxies/1")[0]!.body).toEqual({
      label: "Home",
      enabled: true,
    });
  });

  it("sends a new URL on edit when one is typed, and forgets it after", async () => {
    const server = fakeServer({
      "GET /api/proxies": () => ({ rows: [proxy()] }),
      "PUT /api/proxies/1": () => proxy(),
    });
    const wrapper = await mountPage(server);
    await actions(wrapper, 1).find("[data-action='edit']").trigger("click");
    await flush();
    await urlInput(wrapper).setValue("not a url");
    await dialogButton(wrapper, "Save").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='url-error']").exists()).toBe(true);
    await urlInput(wrapper).setValue(SECRET_URL);
    await dialogButton(wrapper, "Save").trigger("click");
    await flush();
    expect(server.callsTo("PUT /api/proxies/1")[0]!.body).toEqual({
      label: "Home VPN",
      enabled: true,
      url: SECRET_URL,
    });
    await actions(wrapper, 1).find("[data-action='edit']").trigger("click");
    await flush();
    expect((urlInput(wrapper).element as HTMLInputElement).value).toBe("");
  });

  it("shows a save failure in the dialog", async () => {
    const server = fakeServer({
      "GET /api/proxies": () => ({ rows: [proxy()] }),
      "PUT /api/proxies/1": () => apiError(400, "Unsupported proxy scheme"),
    });
    const wrapper = await mountPage(server);
    await actions(wrapper, 1).find("[data-action='edit']").trigger("click");
    await flush();
    await dialogButton(wrapper, "Save").trigger("click");
    await flush();
    expect(wrapper.find("[data-test='proxy-form-error']").text()).toBe("Unsupported proxy scheme");
  });

  it("requires a label", async () => {
    const server = fakeServer({ "GET /api/proxies": () => ({ rows: [] }) });
    const wrapper = await mountPage(server);
    await wrapper.find("[data-action='add-proxy']").trigger("click");
    await flush();
    await urlInput(wrapper).setValue(SECRET_URL);
    await dialogButton(wrapper, "Add proxy").trigger("click");
    await flush();
    expect(wrapper.text()).toContain("Give the proxy a label.");
    await dialogButton(wrapper, "Cancel").trigger("click");
    await flush();
    expect(urlInput(wrapper).exists()).toBe(false);
  });
});

function openDialog(wrapper: VueWrapper) {
  const found = wrapper.findAllComponents(Dialog).find((dialog) => dialog.props("visible"));
  if (found === undefined) throw new Error("no open dialog");
  return found;
}

describe("ProxiesPage dialog closing and cleanup", () => {
  it("opens from the empty state and closes dialogs from their headers", async () => {
    const server = fakeServer({ "GET /api/proxies": () => ({ rows: [] }) });
    const wrapper = await mountPage(server);
    await wrapper.find(".empty-state button").trigger("click");
    await flush();
    openDialog(wrapper).vm.$emit("update:visible", false);
    await flush();
    expect(urlInput(wrapper).exists()).toBe(false);
  });

  it("closes the delete confirmation from its header", async () => {
    const server = fakeServer({ "GET /api/proxies": () => ({ rows: [proxy()] }) });
    const wrapper = await mountPage(server);
    await actions(wrapper, 1).find("[data-action='remove']").trigger("click");
    await flush();
    openDialog(wrapper).vm.$emit("update:visible", false);
    await flush();
    expect(wrapper.find(".confirm-message").exists()).toBe(false);
  });

  it("aborts an in-flight load on unmount", async () => {
    const server = fakeServer({ "GET /api/proxies": () => new Promise(() => undefined) });
    const wrapper = await mountPage(server);
    wrapper.unmount();
    expect(server.calls[0]!.signal?.aborted).toBe(true);
  });
});
