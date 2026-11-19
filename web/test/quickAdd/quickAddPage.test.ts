import { beforeEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { QuickAddResponse } from "@cellar/shared";
import QuickAddPage from "../../src/pages/QuickAddPage.vue";
import { planPaste, quickAddMessage } from "../../src/lib/quickAdd.ts";
import { flush } from "../helpers/dom.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { Reply, fakeApi, type Call, type FakeApi } from "../rules/fakeApi.ts";

beforeEach(() => {
  setActivePinia(createPinia());
});

const A = "dQw4w9WgXcQ";
const B = "aaaaaaaaaaa";
const C = "bbbbbbbbbbb";
const KEY = "POST /api/videos/quick-add";

function response(overrides: Partial<QuickAddResponse> = {}): QuickAddResponse {
  return {
    video_id: A,
    created: true,
    downloaded: false,
    title: null,
    channel_title: null,
    job_id: 7,
    ...overrides,
  };
}

function quickApi(): FakeApi {
  return fakeApi({
    [KEY]: (call: Call) => response({ video_id: (call.body as { input: string }).input }),
  });
}

async function mountPage(fake: FakeApi): Promise<VueWrapper> {
  const wrapper = mount(QuickAddPage, {
    global: mountGlobals({ api: fake.api }),
    attachTo: document.body,
  });
  await flush();
  return wrapper;
}

function field(wrapper: VueWrapper): HTMLInputElement {
  return wrapper.find("[data-test='quick-input']").element as HTMLInputElement;
}

async function paste(wrapper: VueWrapper, text: string): Promise<boolean> {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  field(wrapper).dispatchEvent(event);
  await flush();
  return event.defaultPrevented;
}

function inputs(fake: FakeApi): string[] {
  return fake.callsTo(KEY).map((call) => (call.body as { input: string }).input);
}

describe("planPaste", () => {
  it("leaves a single link in the field", () => {
    expect(planPaste("", ` https://youtu.be/${A} `)).toEqual({
      submit: [],
      rest: `https://youtu.be/${A}`,
    });
  });

  it("adds every link but the last", () => {
    expect(planPaste("", `${A}\n${B}\r\n${C}`)).toEqual({ submit: [A, B], rest: C });
  });

  it("adds every link when the clipboard ends with a new line", () => {
    expect(planPaste("", `${A}\n${B}\n`)).toEqual({ submit: [A, B], rest: "" });
    expect(planPaste("", `${A}\r\n`)).toEqual({ submit: [A], rest: "" });
  });

  it("confirms what the field already holds first", () => {
    expect(planPaste(` ${A} `, B)).toEqual({ submit: [A], rest: B });
    expect(planPaste(A, `${B}\n${C}\n`)).toEqual({ submit: [A, B, C], rest: "" });
  });

  it("ignores a paste with no text", () => {
    expect(planPaste(A, " \n ")).toEqual({ submit: [], rest: A });
  });
});

describe("quickAddMessage", () => {
  it("says what happened", () => {
    expect(quickAddMessage(response())).toBe(
      "Added. Downloading now, and it will be kept forever.",
    );
    expect(quickAddMessage(response({ created: false }))).toBe(
      "Already in the catalog. Downloading now, and it will be kept forever.",
    );
    expect(quickAddMessage(response({ created: false, downloaded: true, job_id: null }))).toBe(
      "Already downloaded. It is now kept forever.",
    );
    expect(quickAddMessage(response({ job_id: null }))).toBe(
      "Added. It will be kept forever, but no download could be queued.",
    );
  });
});

describe("QuickAddPage", () => {
  it("focuses the field on load", async () => {
    const wrapper = await mountPage(quickApi());
    expect(document.activeElement).toBe(field(wrapper));
    expect(wrapper.find(".empty-state").exists()).toBe(true);
    wrapper.unmount();
  });

  it("adds on Enter, clears the field, keeps the focus and confirms below", async () => {
    const fake = fakeApi({
      [KEY]: response({ title: "A synthetic video", channel_title: "Some channel" }),
    });
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-test='quick-input']").setValue(`https://youtu.be/${A}?t=3`);
    await wrapper.find("[data-test='quick-form']").trigger("submit");
    expect(field(wrapper).value).toBe("");
    expect(document.activeElement).toBe(field(wrapper));
    expect(wrapper.find("[data-test='quick-entry']").attributes("data-state")).toBe("pending");
    await flush(5);
    expect(inputs(fake)).toEqual([A]);
    const entry = wrapper.find("[data-test='quick-entry']");
    expect(entry.attributes("data-state")).toBe("ok");
    expect(entry.find("a").attributes("href")).toBe(`/videos/${A}`);
    expect(entry.text()).toContain("A synthetic video");
    expect(entry.text()).toContain("Some channel");
    expect(entry.find("[data-test='quick-message']").text()).toContain("Downloading now");
    wrapper.unmount();
  });

  it("returns the focus to the field after the button is clicked", async () => {
    const fake = quickApi();
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-test='quick-input']").setValue(A);
    (wrapper.find("[data-test='quick-submit']").element as HTMLElement).focus();
    await wrapper.find("[data-test='quick-form']").trigger("submit");
    await flush(5);
    expect(document.activeElement).toBe(field(wrapper));
    expect(inputs(fake)).toEqual([A]);
    wrapper.unmount();
  });

  it("does nothing for an empty field and reports a bad link without calling the server", async () => {
    const fake = quickApi();
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-test='quick-form']").trigger("submit");
    expect(wrapper.findAll("[data-test='quick-entry']")).toHaveLength(0);
    await wrapper.find("[data-test='quick-input']").setValue("not a video");
    await wrapper.find("[data-test='quick-form']").trigger("submit");
    await flush(5);
    const entry = wrapper.find("[data-test='quick-entry']");
    expect(entry.attributes("data-state")).toBe("error");
    expect(entry.text()).toContain("not a video");
    expect(entry.text()).toContain("does not look like a YouTube video");
    expect(fake.calls).toHaveLength(0);
    expect(field(wrapper).value).toBe("");
    wrapper.unmount();
  });

  it("shows the server's error on the entry", async () => {
    const fake = fakeApi({ [KEY]: new Reply(500, { error: "internal error", code: "internal" }) });
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-test='quick-input']").setValue(A);
    await wrapper.find("[data-test='quick-form']").trigger("submit");
    await flush(5);
    const entry = wrapper.find("[data-test='quick-entry']");
    expect(entry.attributes("data-state")).toBe("error");
    expect(entry.find("[data-test='quick-message']").text()).not.toBe("");
    wrapper.unmount();
  });

  it("pasting several links adds all but the last, newest first", async () => {
    const fake = quickApi();
    const wrapper = await mountPage(fake);
    expect(await paste(wrapper, `${A}\n${B}\n${C}`)).toBe(true);
    await flush(8);
    expect(inputs(fake)).toEqual([A, B]);
    expect(field(wrapper).value).toBe(C);
    const links = wrapper.findAll("[data-test='quick-entry'] a").map((a) => a.attributes("href"));
    expect(links).toEqual([`/videos/${B}`, `/videos/${A}`]);
    wrapper.unmount();
  });

  it("pasting with a trailing new line adds every link", async () => {
    const fake = quickApi();
    const wrapper = await mountPage(fake);
    await paste(wrapper, `${A}\n${B}\n`);
    await flush(8);
    expect(inputs(fake)).toEqual([A, B]);
    expect(field(wrapper).value).toBe("");
    wrapper.unmount();
  });

  it("pasting over a link confirms it and holds the pasted one", async () => {
    const fake = quickApi();
    const wrapper = await mountPage(fake);
    await paste(wrapper, A);
    expect(inputs(fake)).toEqual([]);
    expect(field(wrapper).value).toBe(A);
    await paste(wrapper, `https://youtu.be/${B}`);
    await flush(5);
    expect(inputs(fake)).toEqual([A]);
    expect(field(wrapper).value).toBe(`https://youtu.be/${B}`);
    await paste(wrapper, C);
    await flush(5);
    expect(inputs(fake)).toEqual([A, B]);
    expect(field(wrapper).value).toBe(C);
    wrapper.unmount();
  });

  it("leaves an empty paste to the browser", async () => {
    const wrapper = await mountPage(quickApi());
    expect(await paste(wrapper, "")).toBe(false);
    wrapper.unmount();
  });
});
