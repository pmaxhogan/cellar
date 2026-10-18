import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
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
import { apiError, json, noContent, text, type FakeServer } from "../helpers/fakeServer.ts";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function jobRow(wrapper: VueWrapper, id: number) {
  return wrapper.find(`[data-job='${id}']`).element.closest("tr")!;
}

function jobsTable(wrapper: VueWrapper) {
  return wrapper.findComponent(JobsTable);
}

describe("Actions toolbar", () => {
  it("queues an action, disables it while in flight, and reloads the jobs", async () => {
    const reply = deferred<Response>();
    const fake = activityServer().on("POST", "/api/actions/ingest-now", () => reply.promise);
    const wrapper = await mountPage(fake);
    const button = wrapper.find("[data-run-action='ingest-now']");

    await button.trigger("click");
    await flush();
    expect(button.attributes("disabled")).toBeDefined();
    expect(fake.callsTo("POST", "/api/actions/ingest-now")).toHaveLength(1);

    reply.resolve(json({ job_id: 77 }));
    await flush();
    expect(button.attributes("disabled")).toBeUndefined();
    expect(fake.callsTo("GET", "/api/jobs")).toHaveLength(2);
  });

  it("marks an action without a server handler as not available yet", async () => {
    const fake = activityServer().on("POST", "/api/actions/tools-update", () =>
      apiError(501, "Not implemented.", "not_implemented"),
    );
    const wrapper = await mountPage(fake);
    const button = wrapper.find("[data-run-action='tools-update']");
    await button.trigger("click");
    await flush();
    expect(button.attributes("data-unavailable")).toBe("true");
    expect(button.attributes("title")).toContain("Not available yet");
    expect(button.attributes("disabled")).toBeUndefined();
    expect(fake.callsTo("GET", "/api/jobs")).toHaveLength(1);
  });

  it("treats any other failure as a plain error", async () => {
    const fake = activityServer().on("POST", "/api/actions/reap-now", () => apiError(500, "boom"));
    const wrapper = await mountPage(fake);
    const button = wrapper.find("[data-run-action='reap-now']");
    await button.trigger("click");
    await flush();
    expect(button.attributes("data-unavailable")).toBeUndefined();
  });

  it("offers all six actions", async () => {
    const wrapper = await mountPage(activityServer());
    expect(
      wrapper.findAll("[data-run-action]").map((b) => b.attributes("data-run-action")),
    ).toEqual(["ingest-now", "eval-now", "reap-now", "refresh-all", "selfcheck", "tools-update"]);
  });
});

describe("Activity tab", () => {
  it("lists events with level, kind, message and links", async () => {
    const fake = activityServer({
      activity: [
        makeActivity({
          id: 1,
          level: "error",
          message: "Download failed",
          video_id: "v1",
          job_id: 9,
        }),
      ],
    });
    const wrapper = await mountPage(fake);
    const table = wrapper.findComponent(ActivityLogTable);
    expect(table.find("[data-activity='1']").text()).toBe("Download failed");
    expect(table.text()).toContain("error");
    expect(table.find("a").attributes("href")).toBe("/videos/v1");
    expect(table.find("[data-open-job='9']").exists()).toBe(true);
  });

  it("filters by level at once and by kind after a pause", async () => {
    const fake = activityServer();
    const wrapper = await mountPage(fake);
    const table = wrapper.findComponent(ActivityLogTable);

    table.findComponent(Select).vm.$emit("update:modelValue", "error");
    await flush();
    expect(fake.callsTo("GET", "/api/activity").at(-1)!.query.get("level")).toBe("error");

    await table.find("#activity-kind").setValue("reap");
    expect(fake.callsTo("GET", "/api/activity")).toHaveLength(2);
    await wait(350);
    await flush();
    const last = fake.callsTo("GET", "/api/activity").at(-1)!;
    expect(last.query.get("kind")).toBe("reap");
    expect(last.query.get("page")).toBe("1");
    expect(table.find(".empty-state h2").text()).toBe("No events match these filters");
  });

  it("prepends live events that match the filters", async () => {
    const fake = activityServer({ activity: [makeActivity({ id: 1 })] });
    const wrapper = await mountPage(fake);
    const events = useEventsStore();

    events.dispatch({
      type: "activity",
      at: NOW,
      payload: makeActivity({ id: 2, message: "New" }),
    });
    events.dispatch({
      type: "activity",
      at: NOW,
      payload: makeActivity({ id: 2, message: "New" }),
    });
    events.dispatch({ type: "activity", at: NOW, payload: { not: "a row" } });
    await flush();
    const ids = wrapper.findAll("[data-activity]").map((cell) => cell.attributes("data-activity"));
    expect(ids).toEqual(["2", "1"]);

    const table = wrapper.findComponent(ActivityLogTable);
    table.findComponent(Select).vm.$emit("update:modelValue", "error");
    await flush();
    events.dispatch({ type: "activity", at: NOW, payload: makeActivity({ id: 3, level: "info" }) });
    await flush();
    expect(wrapper.find("[data-activity='3']").exists()).toBe(false);
  });

  it("counts live events while a later page is open", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => makeActivity({ id: i + 1 }));
    const fake = activityServer().on("GET", "/api/activity", () => json(paged(rows, 80)));
    const wrapper = await mountPage(fake);
    const table = wrapper.findComponent(ActivityLogTable);
    await table.find("button[aria-label='Next Page']").trigger("click");
    await flush();
    expect(fake.callsTo("GET", "/api/activity").at(-1)!.query.get("page")).toBe("2");

    useEventsStore().dispatch({ type: "activity", at: NOW, payload: makeActivity({ id: 99 }) });
    await flush();
    expect(table.find("[data-pending]").text()).toContain("1 new event");
    await table.find("[data-pending] button").trigger("click");
    await flush();
    expect(fake.callsTo("GET", "/api/activity").at(-1)!.query.get("page")).toBe("1");
  });

  it("shows an error state that retries", async () => {
    let fail = true;
    const fake = activityServer().on("GET", "/api/activity", () =>
      fail ? apiError(500, "down") : json(paged([])),
    );
    const wrapper = await mountPage(fake);
    const table = wrapper.findComponent(ActivityLogTable);
    expect(table.find(".error-state").exists()).toBe(true);
    fail = false;
    await table.find(".error-state button").trigger("click");
    await flush();
    expect(table.find(".empty-state h2").text()).toBe("No activity yet");
  });

  it("opens the job drawer from an event's job link", async () => {
    const fake = activityServer({ activity: [makeActivity({ id: 1, job_id: 5 })] })
      .on("GET", "/api/jobs/5", () => json(makeJob({ id: 5, type: "transcode" })))
      .on("GET", "/api/jobs/5/log", () => json({ files: [] }));
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-open-job='5']").trigger("click");
    await flush();
    expect(wrapper.find("[data-job-facts]").text()).toContain("transcode");
    expect(wrapper.find("[data-no-logs]").exists()).toBe(true);
  });
});

describe("Jobs tab", () => {
  it("filters by status and type", async () => {
    const fake = activityServer();
    const wrapper = await mountPage(fake);
    const selects = jobsTable(wrapper).findAllComponents(Select);
    selects[0]!.vm.$emit("update:modelValue", "failed");
    await flush();
    expect(fake.callsTo("GET", "/api/jobs").at(-1)!.query.get("status")).toBe("failed");
    selects[1]!.vm.$emit("update:modelValue", "download");
    await flush();
    const last = fake.callsTo("GET", "/api/jobs").at(-1)!;
    expect(last.query.get("type")).toBe("download");
    expect(jobsTable(wrapper).find(".empty-state h2").text()).toBe("No jobs match these filters");
  });

  it("shows live progress on a running job, then refreshes it when it finishes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const running = makeJob({ id: 4, status: "running", started_at: NOW - 90_000 });
      const fake = activityServer({ jobs: [running] }).on("GET", "/api/jobs/4", () =>
        json({ ...running, status: "done", finished_at: NOW }),
      );
      const wrapper = await mountPage(fake);
      const events = useEventsStore();
      const row = () => wrapper.find(`[data-job='4']`).element.closest("tr")!;

      expect(row().querySelector("[data-progress]")).toBeNull();
      expect(row().querySelector("[role='progressbar']")).not.toBeNull();
      expect(row().textContent).toContain("1:30");

      events.dispatch({ type: "job.progress", at: NOW, payload: { id: 4, progress: 0.42 } });
      await flush();
      expect(row().querySelector("[data-progress]")?.getAttribute("data-progress")).toBe("42");

      events.dispatch({ type: "job.done", at: NOW, payload: { id: 4 } });
      await flush();
      expect(row().querySelector("[data-job-status]")?.textContent).toBe("done");
      expect(row().querySelector("[role='progressbar']")).toBeNull();

      await wait(450);
      await flush();
      expect(fake.callsTo("GET", "/api/jobs/4")).toHaveLength(1);
      expect(row().textContent).toContain("1:30");
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies a full row from an event, and refreshes a started job", async () => {
    const queued = makeJob({ id: 6, status: "queued" });
    const fake = activityServer({ jobs: [queued] }).on("GET", "/api/jobs/6", () =>
      json({ ...queued, status: "running", started_at: NOW }),
    );
    const wrapper = await mountPage(fake);
    const events = useEventsStore();
    events.dispatch({
      type: "job.failed",
      at: NOW,
      payload: { ...queued, status: "failed", error: "HTTP 403" },
    });
    await flush();
    expect(jobRow(wrapper, 6).textContent).toContain("HTTP 403");

    events.dispatch({ type: "job.started", at: NOW, payload: { job_id: 6 } });
    await wait(450);
    await flush();
    expect(fake.callsTo("GET", "/api/jobs/6").length).toBeGreaterThanOrEqual(1);
  });

  it("counts newly queued jobs instead of refetching", async () => {
    const fake = activityServer({ jobs: [makeJob({ id: 1 })] });
    const wrapper = await mountPage(fake);
    const events = useEventsStore();
    events.dispatch({ type: "job.queued", at: NOW, payload: { id: 50 } });
    events.dispatch({ type: "job.queued", at: NOW, payload: { id: 51 } });
    events.dispatch({ type: "job.done", at: NOW, payload: { id: 52 } });
    await flush();
    const banner = jobsTable(wrapper).find("[data-pending]");
    expect(banner.text()).toContain("2 new jobs");
    expect(fake.callsTo("GET", "/api/jobs")).toHaveLength(1);
    await banner.find("button").trigger("click");
    await flush();
    expect(fake.callsTo("GET", "/api/jobs")).toHaveLength(2);
    expect(jobsTable(wrapper).find("[data-pending]").exists()).toBe(false);
  });

  it("cancels a queued job and retries a failed one", async () => {
    let first = makeJob({ id: 1, status: "queued" });
    let second = makeJob({ id: 2, status: "failed", error: "boom" });
    const fake = activityServer({ jobs: [first, second] })
      .on("POST", "/api/jobs/1/cancel", () => {
        first = { ...first, status: "cancelled" };
        return noContent();
      })
      .on("POST", "/api/jobs/2/retry", () => {
        second = { ...second, status: "queued", error: null };
        return noContent();
      })
      .on("GET", "/api/jobs/1", () => json(first))
      .on("GET", "/api/jobs/2", () => json(second));
    const wrapper = await mountPage(fake);

    expect(jobRow(wrapper, 1).querySelector("[data-job-action='retry']")).toBeNull();
    (jobRow(wrapper, 1).querySelector("[data-job-action='cancel']") as HTMLElement).click();
    await flush();
    expect(fake.callsTo("POST", "/api/jobs/1/cancel")).toHaveLength(1);
    expect(jobRow(wrapper, 1).querySelector("[data-job-status]")?.textContent).toBe("cancelled");
    expect(jobRow(wrapper, 1).querySelector("[data-job-action='retry']")).not.toBeNull();

    (jobRow(wrapper, 2).querySelector("[data-job-action='retry']") as HTMLElement).click();
    await flush();
    expect(fake.callsTo("POST", "/api/jobs/2/retry")).toHaveLength(1);
    expect(jobRow(wrapper, 2).querySelector("[data-job-status]")?.textContent).toBe("queued");
    // Row actions do not open the drawer.
    expect(wrapper.find("[data-job-facts]").exists()).toBe(false);
  });

  it("keeps the row when an action fails", async () => {
    const fake = activityServer({ jobs: [makeJob({ id: 1, status: "running" })] }).on(
      "POST",
      "/api/jobs/1/cancel",
      () => apiError(409, "Already finished."),
    );
    const wrapper = await mountPage(fake);
    (jobRow(wrapper, 1).querySelector("[data-job-action='cancel']") as HTMLElement).click();
    await flush();
    expect(fake.callsTo("GET", "/api/jobs/1")).toHaveLength(0);
    expect(jobRow(wrapper, 1).querySelector("[data-job-status]")?.textContent).toBe("running");
  });

  it("shows an error state for the jobs list", async () => {
    const fake = activityServer().on("GET", "/api/jobs", () => apiError(500, "down"));
    const wrapper = await mountPage(fake);
    expect(jobsTable(wrapper).find(".error-state").exists()).toBe(true);
  });
});

describe("Job drawer and log viewer", () => {
  const job = makeJob({
    id: 3,
    status: "failed",
    error: "ERROR: Sign in to confirm",
    video_id: "v9",
  });
  const longLog = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join("\n");

  function drawerServer() {
    return activityServer({ jobs: [job] })
      .on("GET", "/api/jobs/3", () => json(job))
      .on("GET", "/api/jobs/3/log", () =>
        json({
          files: [
            { name: "yt-dlp.log", size: 2048 },
            { name: "ffmpeg.log", size: 10 },
          ],
        }),
      )
      .on("GET", "/api/jobs/3/log/yt-dlp.log", () => text(`${longLog}\n`))
      .on("GET", "/api/jobs/3/log/ffmpeg.log", () => text("ffmpeg says hi\n"));
  }

  it("opens on row click with the facts, the error and the first log tail-first", async () => {
    const fake = drawerServer();
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-job='3']").trigger("click");
    await flush();

    expect(wrapper.find("[data-job-facts]").text()).toContain("download");
    expect(wrapper.find("[data-job-error]").text()).toBe("ERROR: Sign in to confirm");
    expect(wrapper.find("[data-log-file='yt-dlp.log']").attributes("aria-selected")).toBe("true");
    expect(wrapper.find("[data-log-file='yt-dlp.log']").text()).toContain("2.00 KB");

    const viewer = wrapper.findComponent(JobLogViewer);
    expect(viewer.find("[data-log-truncated]").text()).toContain("Showing the last 400 lines");
    const pre = viewer.find("pre");
    expect(pre.text().split("\n")).toHaveLength(400);
    expect(pre.text().startsWith("line 51")).toBe(true);
    expect(pre.text().endsWith("line 450")).toBe(true);
    expect(viewer.text()).toContain("450 lines");

    await viewer.find("[data-log-action='show-all']").trigger("click");
    expect(viewer.find("pre").text().split("\n")).toHaveLength(450);
    expect(viewer.find("[data-log-truncated]").exists()).toBe(false);
  });

  it("switches files and reloads one", async () => {
    const fake = drawerServer();
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-job='3']").trigger("click");
    await flush();
    await wrapper.find("[data-log-file='ffmpeg.log']").trigger("click");
    await flush();
    const viewer = wrapper.findComponent(JobLogViewer);
    expect(viewer.find("pre").text()).toBe("ffmpeg says hi");
    expect(viewer.find("a").attributes("href")).toBe("/api/jobs/3/log/ffmpeg.log");

    await viewer.find("[data-log-action='reload']").trigger("click");
    await flush();
    expect(fake.callsTo("GET", "/api/jobs/3/log/ffmpeg.log")).toHaveLength(2);
  });

  it("reports a log that cannot be read, and a log list that cannot be read", async () => {
    const fake = drawerServer().on("GET", "/api/jobs/3/log/yt-dlp.log", () =>
      apiError(404, "Log file not found."),
    );
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-job='3']").trigger("click");
    await flush();
    expect(wrapper.findComponent(JobLogViewer).find("[role='alert']").text()).toBe(
      "Log file not found.",
    );

    const broken = drawerServer().on("GET", "/api/jobs/3/log", () => apiError(500, "No dir."));
    const second = await mountPage(broken);
    await second.find("[data-job='3']").trigger("click");
    await flush();
    expect(second.text()).toContain("No dir.");
  });

  it("says when a job cannot be loaded", async () => {
    const fake = activityServer({ activity: [makeActivity({ job_id: 404 })] })
      .on("GET", "/api/jobs/404", () => apiError(404, "Job not found."))
      .on("GET", "/api/jobs/404/log", () => json({ files: [] }));
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-open-job='404']").trigger("click");
    await flush();
    expect(wrapper.text()).toContain("Job not found.");
  });

  it("renders an empty log", async () => {
    const fake = drawerServer().on("GET", "/api/jobs/3/log/yt-dlp.log", () => text(""));
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-job='3']").trigger("click");
    await flush();
    expect(wrapper.findComponent(JobLogViewer).text()).toContain("This log file is empty.");
  });
});

describe("Activity page copy", () => {
  it("uses ASCII only", async () => {
    const fake = activityServer({
      jobs: [makeJob({ status: "running" })],
      activity: [makeActivity({ video_id: "v1", job_id: 1 })],
    });
    const wrapper = await mountPage(fake);
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(wrapper.text())).toBe(true);
  });
});
