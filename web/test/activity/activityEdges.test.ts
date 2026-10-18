import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import Select from "primevue/select";
import { createMemoryHistory, createRouter } from "vue-router";
import ActivityPage from "../../src/pages/ActivityPage.vue";
import ActivityLogTable from "../../src/components/activity/ActivityLogTable.vue";
import JobsTable from "../../src/components/activity/JobsTable.vue";
import JobLogViewer from "../../src/components/activity/JobLogViewer.vue";
import { routes } from "../../src/router/index.ts";
import { useEventsStore } from "../../src/stores/events.ts";
import { flush } from "../helpers/dom.ts";
import { json, text, type FakeServer } from "../helpers/fakeServer.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { NOW, activityServer, makeActivity, makeJob, paged } from "./fixtures.ts";

let pinia: Pinia;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

async function mountPage(fake: FakeServer) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push("/activity");
  await router.isReady();
  const wrapper = mount(ActivityPage, { global: mountGlobals({ api: fake.api, pinia, router }) });
  await flush();
  return wrapper;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The first request to a path hangs until released; later ones answer at once. */
function holdFirst(reply: () => Response) {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = async () => {
    calls += 1;
    if (calls === 1) await gate;
    return reply();
  };
  return { handler, release: () => release() };
}

describe("Activity page tabs", () => {
  it("switches between the activity log and the jobs", async () => {
    const wrapper = await mountPage(activityServer());
    const tabs = wrapper.findAll("[role='tab']");
    const jobs = tabs.find((tab) => tab.text() === "Jobs")!;
    await jobs.trigger("click");
    await flush();
    expect(jobs.attributes("aria-selected")).toBe("true");
    const activity = wrapper.findAll("[role='tab']").find((tab) => tab.text() === "Activity")!;
    await activity.trigger("click");
    await flush();
    expect(activity.attributes("aria-selected")).toBe("true");
  });
});

describe("Jobs table edges", () => {
  it("drops a superseded load when the filter changes mid-flight", async () => {
    const held = holdFirst(() => json(paged([makeJob({ id: 1 })])));
    const fake = activityServer().on("GET", "/api/jobs", held.handler);
    const wrapper = await mountPage(fake);
    const table = wrapper.findComponent(JobsTable);
    table.findAllComponents(Select)[0]!.vm.$emit("update:modelValue", "done");
    await flush();
    held.release();
    await flush();
    expect(table.findAll("[data-job]")).toHaveLength(1);
    expect(table.find(".error-state").exists()).toBe(false);
  });

  it("resets its filters and pages through results", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => makeJob({ id: i + 1 }));
    const fake = activityServer().on("GET", "/api/jobs", () => json(paged(rows, 60)));
    const wrapper = await mountPage(fake);
    const table = wrapper.findComponent(JobsTable);

    table.findAllComponents(Select)[0]!.vm.$emit("update:modelValue", "queued");
    await flush();
    const reset = table.findAll("button").find((button) => button.text() === "Reset")!;
    await reset.trigger("click");
    await flush();
    expect(fake.callsTo("GET", "/api/jobs").at(-1)!.query.has("status")).toBe(false);

    await table.find("button[aria-label='Next Page']").trigger("click");
    await flush();
    const last = fake.callsTo("GET", "/api/jobs").at(-1)!;
    expect(last.query.get("page")).toBe("2");
    expect(last.query.get("perPage")).toBe("25");
  });

  it("keeps a row when its refresh fails, and stops timers on unmount", async () => {
    const fake = activityServer({ jobs: [makeJob({ id: 2, status: "running" })] });
    const wrapper = await mountPage(fake);
    const events = useEventsStore();
    events.dispatch({ type: "job.done", at: NOW, payload: { id: 2 } });
    await wait(450);
    await flush();
    expect(fake.callsTo("GET", "/api/jobs/2")).toHaveLength(1);
    expect(wrapper.find("[data-job-status]").text()).toBe("done");

    events.dispatch({ type: "job.failed", at: NOW, payload: { id: 2 } });
    await wrapper.findComponent(ActivityLogTable).find("#activity-kind").setValue("x");
    wrapper.unmount();
    await wait(450);
    expect(fake.callsTo("GET", "/api/jobs/2")).toHaveLength(1);
    expect(fake.callsTo("GET", "/api/activity")).toHaveLength(1);
  });
});

describe("Activity log edges", () => {
  it("drops a superseded load and resets its filters", async () => {
    const held = holdFirst(() => json(paged([makeActivity({ id: 1 })])));
    const fake = activityServer().on("GET", "/api/activity", held.handler);
    const wrapper = await mountPage(fake);
    const table = wrapper.findComponent(ActivityLogTable);
    table.findComponent(Select).vm.$emit("update:modelValue", "warn");
    await flush();
    held.release();
    await flush();
    expect(table.findAll("[data-activity]")).toHaveLength(1);

    const reset = table.findAll("button").find((button) => button.text() === "Reset")!;
    await reset.trigger("click");
    await flush();
    expect(fake.callsTo("GET", "/api/activity").at(-1)!.query.has("level")).toBe(false);
  });

  it("resets from the empty state of a filtered search", async () => {
    const fake = activityServer();
    const wrapper = await mountPage(fake);
    const table = wrapper.findComponent(ActivityLogTable);
    table.findComponent(Select).vm.$emit("update:modelValue", "debug");
    await flush();
    const reset = table.findAll("button").find((button) => button.text() === "Reset filters")!;
    await reset.trigger("click");
    await flush();
    expect(table.find(".empty-state h2").text()).toBe("No activity yet");
  });
});

describe("Job drawer edges", () => {
  function server() {
    return activityServer({
      jobs: [makeJob({ id: 1 }), makeJob({ id: 2, type: "reap" })],
    })
      .on("GET", "/api/jobs/1", () => json(makeJob({ id: 1 })))
      .on("GET", "/api/jobs/2", () => json(makeJob({ id: 2, type: "reap" })))
      .on("GET", /^\/api\/jobs\/\d+\/log$/, () =>
        json({
          files: [
            { name: "a.log", size: 1 },
            { name: "b.log", size: 1 },
          ],
        }),
      )
      .on("GET", /^\/api\/jobs\/\d+\/log\/.+$/, () => text("x\n"));
  }

  it("shows only the most recently opened job", async () => {
    const held = holdFirst(() => json(makeJob({ id: 1, type: "stale" })));
    const fake = server().on("GET", "/api/jobs/1", held.handler);
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-job='1']").trigger("click");
    await flush();
    await wrapper.find("[data-job='2']").trigger("click");
    await flush();
    held.release();
    await flush();
    expect(wrapper.find("[data-job-facts]").text()).toContain("reap");
    expect(wrapper.find("[data-job-facts]").text()).not.toContain("stale");
  });

  it("drops a superseded log fetch when another file is picked, and closes", async () => {
    const held = holdFirst(() => text("first\n"));
    const fake = server().on("GET", "/api/jobs/1/log/a.log", held.handler);
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-job='1']").trigger("click");
    await flush();
    await wrapper.find("[data-log-file='b.log']").trigger("click");
    await flush();
    held.release();
    await flush();
    expect(wrapper.findComponent(JobLogViewer).find("pre").text()).toBe("x");

    const close = wrapper.find(".p-drawer-close-button, .p-drawer button[aria-label='Close']");
    await close.trigger("click");
    await flush();
    expect(wrapper.find("[data-job-facts]").exists()).toBe(false);
  });
});
