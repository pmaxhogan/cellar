import { describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import type { ToastServiceMethods } from "primevue/toastservice";
import { useToast } from "primevue/usetoast";
import AppIcon from "../src/components/AppIcon.vue";
import ConfirmDialog from "../src/components/ConfirmDialog.vue";
import EmptyState from "../src/components/EmptyState.vue";
import ErrorState from "../src/components/ErrorState.vue";
import ListSkeleton from "../src/components/ListSkeleton.vue";
import PageHeader from "../src/components/PageHeader.vue";
import { ApiClientError } from "../src/api/client.ts";
import { useToaster, type Toaster } from "../src/lib/toast.ts";
import { flush } from "./helpers/dom.ts";
import { mountGlobals } from "./helpers/mount.ts";

describe("AppIcon", () => {
  it("is decorative by default", () => {
    const wrapper = mount(AppIcon, { props: { name: "videos" } });
    expect(wrapper.attributes("aria-hidden")).toBe("true");
    expect(wrapper.attributes("role")).toBeUndefined();
    expect(wrapper.attributes("width")).toBe("18");
    expect(wrapper.find("title").exists()).toBe(false);
  });

  it("becomes a labelled image when given a title", () => {
    const wrapper = mount(AppIcon, { props: { name: "alert", title: "Failed", size: 24 } });
    expect(wrapper.attributes("aria-hidden")).toBeUndefined();
    expect(wrapper.attributes("role")).toBe("img");
    expect(wrapper.find("title").text()).toBe("Failed");
  });

  it("falls back to a known glyph for an unknown name", () => {
    const unknown = mount(AppIcon, { props: { name: "nope" } });
    const about = mount(AppIcon, { props: { name: "about" } });
    expect(unknown.find("path").attributes("d")).toBe(about.find("path").attributes("d"));
  });
});

describe("PageHeader", () => {
  it("renders the title, the optional description and the actions slot", () => {
    const wrapper = mount(PageHeader, {
      props: { title: "Rules", description: "Ordered rules." },
      slots: { actions: "<button>New rule</button>" },
    });
    expect(wrapper.find("h1").text()).toBe("Rules");
    expect(wrapper.find("p").text()).toBe("Ordered rules.");
    expect(wrapper.find(".page-header__actions button").text()).toBe("New rule");
  });

  it("omits the description paragraph when there is none", () => {
    const wrapper = mount(PageHeader, { props: { title: "Rules" } });
    expect(wrapper.find("p").exists()).toBe(false);
  });
});

describe("EmptyState", () => {
  it("renders an icon, a title, a description and actions", () => {
    const wrapper = mount(EmptyState, {
      props: { icon: "rules", title: "No rules", description: "Add one." },
      slots: { default: "<button>Add</button>" },
    });
    expect(wrapper.find("[data-icon='rules']").exists()).toBe(true);
    expect(wrapper.find("h2").text()).toBe("No rules");
    expect(wrapper.find("p").text()).toBe("Add one.");
    expect(wrapper.find("button").text()).toBe("Add");
  });

  it("defaults the icon and drops the description", () => {
    const wrapper = mount(EmptyState, { props: { title: "Nothing" } });
    expect(wrapper.find("[data-icon='videos']").exists()).toBe(true);
    expect(wrapper.find("p").exists()).toBe(false);
  });
});

describe("ErrorState", () => {
  it("renders nothing without an error", () => {
    const wrapper = mount(ErrorState, { props: { error: null }, global: mountGlobals() });
    expect(wrapper.find(".error-state").exists()).toBe(false);
  });

  it("shows the message and code as an alert and emits retry", async () => {
    const error = new ApiClientError("http_503", "The server is not ready yet.", 503);
    const wrapper = mount(ErrorState, {
      props: { error, title: "Could not load" },
      global: mountGlobals(),
    });
    expect(wrapper.find("[role='alert']").exists()).toBe(true);
    expect(wrapper.find("h2").text()).toBe("Could not load");
    expect(wrapper.find(".error-state__message").text()).toBe("The server is not ready yet.");
    expect(wrapper.find(".error-state__code").text()).toBe("http_503");
    await wrapper.find("button").trigger("click");
    expect(wrapper.emitted("retry")).toHaveLength(1);
  });

  it("has a default title", () => {
    const wrapper = mount(ErrorState, {
      props: { error: new ApiClientError("x", "y") },
      global: mountGlobals(),
    });
    expect(wrapper.find("h2").text()).toBe("Something went wrong");
  });
});

describe("ListSkeleton", () => {
  it("renders the requested rows behind a status label", () => {
    const wrapper = mount(ListSkeleton, {
      props: { rows: 2, label: "Loading videos" },
      global: mountGlobals(),
    });
    expect(wrapper.attributes("role")).toBe("status");
    expect(wrapper.attributes("aria-busy")).toBe("true");
    expect(wrapper.find(".sr-only").text()).toBe("Loading videos");
    expect(wrapper.findAll(".list-skeleton__row")).toHaveLength(2);
  });

  it("defaults to four rows", () => {
    const wrapper = mount(ListSkeleton, { global: mountGlobals() });
    expect(wrapper.findAll(".list-skeleton__row")).toHaveLength(4);
  });
});

describe("ConfirmDialog", () => {
  async function open(props: Record<string, unknown> = {}) {
    const wrapper = mount(ConfirmDialog, {
      props: { visible: true, title: "Revoke link?", message: "It stops working.", ...props },
      global: mountGlobals(),
    });
    await flush();
    return wrapper;
  }

  const button = (wrapper: Awaited<ReturnType<typeof open>>, label: string) =>
    wrapper.findAll("button").find((candidate) => candidate.text().trim() === label);

  it("shows the title and message when visible", async () => {
    const wrapper = await open();
    expect(wrapper.text()).toContain("Revoke link?");
    expect(wrapper.find(".confirm-message").text()).toBe("It stops working.");
  });

  it("emits confirm, and closes on cancel", async () => {
    const wrapper = await open({ confirmLabel: "Revoke", danger: true });
    await button(wrapper, "Revoke")!.trigger("click");
    expect(wrapper.emitted("confirm")).toHaveLength(1);
    await button(wrapper, "Cancel")!.trigger("click");
    expect(wrapper.emitted("update:visible")?.[0]).toEqual([false]);
  });

  it("locks cancel while busy", async () => {
    const wrapper = await open({ busy: true });
    expect(button(wrapper, "Cancel")!.attributes("disabled")).toBeDefined();
  });

  it("renders nothing when hidden", async () => {
    const wrapper = await open({ visible: false });
    expect(wrapper.find(".confirm-message").exists()).toBe(false);
  });
});

describe("useToaster", () => {
  function captureToaster(withService: boolean) {
    let toaster: Toaster | null = null;
    let service: ToastServiceMethods | null = null;
    const Probe = defineComponent({
      setup() {
        toaster = useToaster();
        if (withService) service = useToast();
        return () => h("div");
      },
    });
    mount(Probe, { global: withService ? mountGlobals() : {} });
    if (toaster === null) throw new Error("probe did not run");
    return { toaster: toaster as Toaster, service: service as ToastServiceMethods | null };
  }

  it("is a silent no-op without the ToastService", () => {
    const { toaster } = captureToaster(false);
    expect(() => toaster.success("Saved")).not.toThrow();
    expect(() => toaster.failure("Failed", new Error("x"))).not.toThrow();
  });

  it("forwards each severity to the service, normalizing failures", () => {
    const { toaster, service } = captureToaster(true);
    const add = vi.spyOn(service!, "add").mockImplementation(() => undefined);
    toaster.success("Saved", "All good");
    toaster.info("Heads up");
    toaster.warn("Careful");
    toaster.failure("Failed", new ApiClientError("x", "Boom"));
    expect(add.mock.calls.map(([message]) => [message.severity, message.summary])).toEqual([
      ["success", "Saved"],
      ["info", "Heads up"],
      ["warn", "Careful"],
      ["error", "Failed"],
    ]);
    expect(add.mock.calls[3]![0].detail).toBe("Boom");
    expect(add.mock.calls[2]![0].life).toBe(6000);
  });

  it("shows an error the caller words itself, without the network prefix", () => {
    const { toaster, service } = captureToaster(true);
    const add = vi.spyOn(service!, "add").mockImplementation(() => undefined);
    toaster.error("Update check failed", "ffmpeg: failed");
    expect(add.mock.calls[0]![0]).toMatchObject({
      severity: "error",
      summary: "Update check failed",
      detail: "ffmpeg: failed",
      life: 8000,
    });
  });
});
