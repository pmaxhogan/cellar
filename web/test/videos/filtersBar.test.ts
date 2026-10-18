import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import InputNumber from "primevue/inputnumber";
import MultiSelect from "primevue/multiselect";
import Select from "primevue/select";
import VideoFiltersBar from "../../src/components/videos/VideoFiltersBar.vue";
import ChannelPicker from "../../src/components/rules/ChannelPicker.vue";
import { emptyFilters, type VideoFilters } from "../../src/api/videos.ts";
import { flush } from "../helpers/dom.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { UC } from "./fixtures.ts";

afterEach(() => {
  vi.useRealTimers();
});

function mountBar(filters: Partial<VideoFilters> = {}) {
  return mount(VideoFiltersBar, {
    props: {
      modelValue: { ...emptyFilters(), ...filters },
      accounts: [{ id: 1, label: "main" }],
      locations: [{ id: 2, label: "Fast disk" }],
    },
    global: mountGlobals(),
  });
}

function last(wrapper: VueWrapper): VideoFilters {
  const events = wrapper.emitted("update:modelValue") as VideoFilters[][] | undefined;
  if (events === undefined) throw new Error("nothing emitted");
  return events[events.length - 1]![0]!;
}

describe("VideoFiltersBar", () => {
  it("debounces the search box, and Enter searches at once", async () => {
    vi.useFakeTimers();
    const wrapper = mountBar();
    const input = wrapper.find("[data-test='video-search']");
    await input.setValue("ca");
    await input.setValue("cats");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    vi.advanceTimersByTime(299);
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(last(wrapper).q).toBe("cats");
    expect(wrapper.emitted("update:modelValue")).toHaveLength(1);

    await input.setValue("dogs");
    await input.trigger("keyup", { key: "Enter" });
    expect(last(wrapper).q).toBe("dogs");
    vi.advanceTimersByTime(400);
    expect(wrapper.emitted("update:modelValue")).toHaveLength(2);
  });

  it("does not emit when the debounced text matches the current query", async () => {
    vi.useFakeTimers();
    const wrapper = mountBar({ q: "cats" });
    await wrapper.find("[data-test='video-search']").setValue("cats ");
    vi.advanceTimersByTime(400);
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("follows a query changed from outside", async () => {
    const wrapper = mountBar({ q: "one" });
    await wrapper.setProps({ modelValue: { ...emptyFilters(), q: "two" } });
    expect((wrapper.find("[data-test='video-search']").element as HTMLInputElement).value).toBe(
      "two",
    );
  });

  it("emits each select, list, channel and range change", async () => {
    const wrapper = mountBar();
    const [source, status, type] = wrapper.findAllComponents(MultiSelect);
    source!.vm.$emit("update:modelValue", ["liked"]);
    expect(last(wrapper).source).toEqual(["liked"]);
    status!.vm.$emit("update:modelValue", ["gone"]);
    expect(last(wrapper).status).toEqual(["gone"]);
    type!.vm.$emit("update:modelValue", ["short"]);
    expect(last(wrapper).type).toEqual(["short"]);

    const [downloaded, accountSelect, pri, locationSelect] = wrapper.findAllComponents(Select);
    downloaded!.vm.$emit("update:modelValue", "no");
    expect(last(wrapper).downloaded).toBe("no");
    downloaded!.vm.$emit("update:modelValue", null);
    expect(last(wrapper).downloaded).toBeNull();
    accountSelect!.vm.$emit("update:modelValue", 1);
    expect(last(wrapper).account_id).toBe(1);
    accountSelect!.vm.$emit("update:modelValue", undefined);
    expect(last(wrapper).account_id).toBeNull();
    pri!.vm.$emit("update:modelValue", "positive");
    expect(last(wrapper).pri).toBe("positive");
    pri!.vm.$emit("update:modelValue", null);
    expect(last(wrapper).pri).toBeNull();
    locationSelect!.vm.$emit("update:modelValue", 2);
    expect(last(wrapper).location_id).toBe(2);
    locationSelect!.vm.$emit("update:modelValue", null);
    expect(last(wrapper).location_id).toBeNull();

    const channel = wrapper.findComponent(ChannelPicker);
    channel.vm.$emit("update:modelValue", UC);
    expect(last(wrapper).channel_id).toBe(UC);
    channel.vm.$emit("update:modelValue", null);
    expect(last(wrapper).channel_id).toBeNull();

    const [min, max] = wrapper.findAllComponents(InputNumber);
    min!.vm.$emit("update:modelValue", 5);
    expect(last(wrapper).min_duration).toBe(300);
    max!.vm.$emit("update:modelValue", null);
    expect(last(wrapper).max_duration).toBeNull();
    min!.vm.$emit("update:modelValue", -1);
    expect(last(wrapper).min_duration).toBeNull();

    const from = wrapper.find("[data-test='filter-date-from']");
    await from.setValue("2024-02-03");
    await from.trigger("change");
    expect(last(wrapper).date_from).toBe("2024-02-03");
    const to = wrapper.find("[data-test='filter-date-to']");
    await to.setValue("");
    await to.trigger("change");
    expect(last(wrapper).date_to).toBeNull();
  });

  it("shows minutes for stored seconds, expands, and resets", async () => {
    const wrapper = mountBar({ min_duration: 600, status: ["gone"] });
    const [min] = wrapper.findAllComponents(InputNumber);
    expect(min!.props("modelValue")).toBe(10);
    const more = wrapper.find("[data-test='filters-more']");
    expect((more.element as HTMLElement).style.display).toBe("none");
    await wrapper.find("[data-test='filters-toggle']").trigger("click");
    await flush();
    expect((more.element as HTMLElement).style.display).toBe("");
    await wrapper.find("[data-test='filters-reset']").trigger("click");
    expect(last(wrapper)).toEqual(emptyFilters());
  });

  it("hides the reset button without filters", () => {
    expect(mountBar().find("[data-test='filters-reset']").exists()).toBe(false);
  });
});
