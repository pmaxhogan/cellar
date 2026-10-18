import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ToolVersionsCard from "../../src/components/about/ToolVersionsCard.vue";
import type { ToolsResponse, ToolVersions } from "../../src/api/tools.ts";
import { flush } from "../helpers/dom.ts";
import { fakeServer, json } from "../helpers/fakeServer.ts";
import { mountGlobals } from "../helpers/mount.ts";

function versions(overrides: Partial<ToolVersions> = {}): ToolVersions {
  return {
    current: "a",
    previous: "b",
    baseline: "c",
    latest: "a",
    checked_at: null,
    updated_at: null,
    ...overrides,
  };
}

function tools(overrides: Partial<ToolsResponse> = {}): ToolsResponse {
  return {
    ytdlp: versions(),
    ffmpeg: versions(),
    js_runtime: null,
    pot_provider_url: null,
    ...overrides,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("ToolVersionsCard", () => {
  it("emits the new state even when the server reports no current version", async () => {
    const empty = tools({ ytdlp: versions({ current: null }) });
    const fake = fakeServer()
      .on("POST", "/api/tools/update", () => json(empty))
      .on("POST", "/api/tools/rollback", () => json(empty));
    const wrapper = mount(ToolVersionsCard, {
      props: { tools: tools() },
      global: mountGlobals({ api: fake.api }),
    });

    await wrapper.find("[data-tool-row='ytdlp'] [data-tool-action='update']").trigger("click");
    await flush();
    await wrapper.find("[data-tool-row='ytdlp'] [data-tool-action='rollback']").trigger("click");
    await flush();
    const confirm = wrapper
      .findAll("button")
      .filter((button) => button.text() === "Roll back")
      .at(-1)!;
    await confirm.trigger("click");
    await flush();
    expect(wrapper.emitted("update:tools")).toHaveLength(2);
  });

  it("words the roll back prompt when the current version is unknown", async () => {
    const wrapper = mount(ToolVersionsCard, {
      props: { tools: tools({ ffmpeg: versions({ current: null, previous: "6.1" }) }) },
      global: mountGlobals({ api: fakeServer().api }),
    });
    await wrapper.find("[data-tool-row='ffmpeg'] [data-tool-action='rollback']").trigger("click");
    await flush();
    expect(wrapper.text()).toContain("from the current build back to 6.1");
  });
});
