import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import Select from "primevue/select";
import type { StatsDailyResponse } from "@cellar/shared";
import ChartsPage from "../../src/pages/ChartsPage.vue";
import ChartCard from "../../src/components/charts/ChartCard.vue";
import type { ChartConfig } from "../../src/components/charts/series.ts";
import { HOURLY_REFRESH_MS, rangeWindow } from "../../src/api/stats.ts";
import { HOUR_AXIS_TITLE, hourLabel } from "../../src/components/charts/hourlySeries.ts";
import { useThemeStore } from "../../src/stores/theme.ts";
import { flush } from "../helpers/dom.ts";
import { apiError, fakeServer, json, type FakeServer } from "../helpers/fakeServer.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { ChartStub, makeDaily, makeHourly, makeSummary } from "./fixtures.ts";

let pinia: Pinia;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

function server(daily: StatsDailyResponse | ((query: URLSearchParams) => StatsDailyResponse)) {
  return fakeServer()
    .on("GET", "/api/stats/summary", () => json(makeSummary()))
    .on("GET", "/api/stats/daily", (request) =>
      json(typeof daily === "function" ? daily(request.query) : daily),
    )
    .on("GET", "/api/stats/hourly", () => json(makeHourly()))
    .on("POST", "/api/stats/rollup", () =>
      json({ points: 16, from: "2026-10-11", to: "2026-10-18" }),
    );
}

async function mountPage(fake: FakeServer): Promise<VueWrapper> {
  const globals = mountGlobals({ api: fake.api, pinia });
  const wrapper = mount(ChartsPage, {
    global: { ...globals, stubs: { ...globals.stubs, Chart: ChartStub } },
  });
  await flush();
  return wrapper;
}

function chart(wrapper: VueWrapper, id: string): ChartConfig {
  const card = wrapper
    .findAllComponents(ChartCard)
    .find((candidate) => candidate.props("chartId") === id);
  if (card === undefined) throw new Error(`no chart ${id}`);
  return card.props("config") as ChartConfig;
}

function chartIds(wrapper: VueWrapper): string[] {
  return wrapper.findAll("[data-chart]").map((card) => card.attributes("data-chart") ?? "");
}

describe("Charts page summary", () => {
  it("renders the tiles from the live summary", async () => {
    const wrapper = await mountPage(server(makeDaily()));
    expect(wrapper.find("[data-tile='catalog'] [data-value]").text()).toBe("1,234");
    expect(wrapper.find("[data-tile='downloaded'] [data-value]").text()).toBe("800");
    expect(wrapper.find("[data-tile='downloaded'] [data-detail]").text()).toBe(
      "21 downloads in 7 days, 90 in 30",
    );
    expect(wrapper.find("[data-tile='gone'] [data-value]").text()).toBe("7");

    const media = wrapper.find("[data-tile='storage-1']");
    expect(media.find("[data-value]").text()).toBe("950 GB");
    expect(media.find("[data-detail]").text()).toBe("92.8% of 1.00 TB quota, nearing the limit");
    expect(media.find("[role='meter']").attributes("data-tone")).toBe("warn");
    const second = wrapper.find("[data-tile='storage-2']");
    expect(second.find("[data-detail]").text()).toBe("No quota set");
    expect(second.find("[role='meter']").exists()).toBe(false);
    // A disabled location with nothing on it is left out.
    expect(wrapper.find("[data-tile='storage-3']").exists()).toBe(false);

    const apiTile = wrapper.find("[data-tile='api']");
    expect(apiTile.find("[data-value]").text()).toBe("8,500 / 10,000");
    expect(apiTile.find("[data-detail]").text()).toBe("85% of 10,000 a day, nearing the limit");
    expect(apiTile.find("[role='meter']").attributes("aria-valuenow")).toBe("8500");
  });

  it("marks a spent budget, a full disk and a disabled location that holds files", async () => {
    const fake = server(makeDaily()).on("GET", "/api/stats/summary", () =>
      json(
        makeSummary({
          api_units_today: 10_000,
          bytes_by_location: [
            { id: 1, label: "media", enabled: true, bytes_used: 99, quota_bytes: 100 },
            { id: 3, label: "cold", enabled: false, bytes_used: 50, quota_bytes: 0 },
          ],
        }),
      ),
    );
    const wrapper = await mountPage(fake);
    expect(wrapper.find("[data-tile='api'] [role='meter']").attributes("data-tone")).toBe("danger");
    expect(wrapper.find("[data-tile='api'] [data-detail]").text()).toContain("at the limit");
    expect(wrapper.find("[data-tile='storage-1'] [role='meter']").attributes("data-tone")).toBe(
      "danger",
    );
    expect(wrapper.find("[data-tile='storage-3'] [data-detail]").text()).toBe(
      "No quota set (disabled)",
    );
  });

  it("says so when the summary fails but still draws the charts", async () => {
    const fake = server(makeDaily()).on("GET", "/api/stats/summary", () =>
      apiError(500, "internal error", "internal"),
    );
    const wrapper = await mountPage(fake);
    expect(wrapper.find("[data-summary-error]").text()).toContain("Could not load the summary");
    expect(chartIds(wrapper)).toContain("storage");
    // Without the summary there is no budget to draw.
    expect(chart(wrapper, "api").data.datasets.map((dataset) => dataset.label)).toEqual([
      "API units",
    ]);
  });
});

describe("Charts page charts", () => {
  it("feeds every chart its datasets for all locations", async () => {
    const fake = server(makeDaily());
    const wrapper = await mountPage(fake);
    expect(chartIds(wrapper)).toEqual(["storage", "downloads", "catalog", "gone", "api"]);

    const storage = chart(wrapper, "storage");
    expect(storage.type).toBe("line");
    expect(storage.data.labels).toEqual(["Oct 16", "Oct 17", "Oct 18"]);
    expect(storage.data.datasets.map((dataset) => [dataset.label, dataset.data])).toEqual([
      ["media", [200, null, 600]],
      ["second", [100, null, 300]],
    ]);
    const [first, second] = storage.data.datasets;
    expect(first?.borderColor).not.toBe(second?.borderColor);

    const downloads = chart(wrapper, "downloads");
    expect(downloads.type).toBe("bar");
    expect(downloads.data.datasets[0]?.data).toEqual([1, null, 3]);
    expect(chart(wrapper, "catalog").data.datasets[0]?.data).toEqual([10, null, 12]);
    expect(chart(wrapper, "gone").data.datasets[0]?.data).toEqual([1, null, 2]);

    const apiChart = chart(wrapper, "api");
    expect(apiChart.data.datasets.map((dataset) => [dataset.type, dataset.label])).toEqual([
      ["bar", "API units"],
      ["line", "Daily budget"],
    ]);
    expect(apiChart.data.datasets[1]?.data).toEqual([10_000, 10_000, 10_000]);
    expect((apiChart.data.datasets[1] as { borderDash?: number[] }).borderDash).toEqual([6, 4]);

    // Rendered through the (stubbed) PrimeVue Chart with the same config.
    expect(
      wrapper.find("[data-chart='storage'] [data-chart-stub='line']").attributes(),
    ).toMatchObject({ "data-datasets": "media|second" });
    expect(wrapper.findAll("[data-chart-stub]")).toHaveLength(5);

    const query = fake.callsTo("GET", "/api/stats/daily")[0]!.query;
    expect(query.get("location_id")).toBe("all");
    expect(query.get("from")).toBe(rangeWindow(90).from);
    expect(query.get("to")).toBe(rangeWindow(90).to);
  });

  it("offers the points as a table", async () => {
    const wrapper = await mountPage(server(makeDaily()));
    const table = wrapper.find("details.points-table");
    expect(table.find("summary").text()).toBe("Show the data as a table (6 rows)");
    const firstRow = table.findAll("tbody tr")[0]!;
    expect(firstRow.text()).toContain("2026-10-18");
    expect(firstRow.text()).toContain("All locations");
    expect(firstRow.text()).toContain("900 B");
  });

  it("refetches when the range changes", async () => {
    const fake = server(makeDaily());
    const wrapper = await mountPage(fake);
    const thirty = wrapper
      .findAll("[data-filter='range'] button")
      .find((button) => button.text() === "30 days");
    await thirty!.trigger("click");
    await flush();
    const calls = fake.callsTo("GET", "/api/stats/daily");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.query.get("from")).toBe(rangeWindow(30).from);
    expect(calls[1]!.query.get("location_id")).toBe("all");
  });

  it("refetches for one location and drops the catalog-wide charts", async () => {
    const fake = server((query) =>
      query.get("location_id") === "2"
        ? makeDaily({ points: makeDaily().points.filter((p) => p.location_id === 2) })
        : makeDaily(),
    );
    const wrapper = await mountPage(fake);
    wrapper.findComponent(Select).vm.$emit("update:modelValue", 2);
    await flush();

    const calls = fake.callsTo("GET", "/api/stats/daily");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.query.get("location_id")).toBe("2");
    expect(chartIds(wrapper)).toEqual(["storage", "downloads", "catalog"]);
    expect(wrapper.find("[data-chart='storage'] h2").text()).toBe("Storage used on second");
    const storage = chart(wrapper, "storage");
    expect(storage.data.datasets.map((dataset) => dataset.label)).toEqual(["second"]);
    // The location keeps its slot color from the all-locations view.
    expect(storage.data.datasets[0]?.borderColor).toBe("#d95926");
    expect(chart(wrapper, "downloads").data.datasets[0]?.data).toEqual([0, null, 1]);
    expect(chart(wrapper, "catalog").data.datasets[0]?.label).toBe("Videos with files here");
    expect(wrapper.find("[data-location-note]").exists()).toBe(true);
  });

  it("redraws in the light scheme when the theme toggles", async () => {
    const wrapper = await mountPage(server(makeDaily()));
    const darkColor = chart(wrapper, "downloads").data.datasets[0]?.backgroundColor;
    useThemeStore().toggle();
    await flush();
    const lightColor = chart(wrapper, "downloads").data.datasets[0]?.backgroundColor;
    expect(darkColor).toBe("#e2738e");
    expect(lightColor).toBe("#8e2643");
    useThemeStore().toggle();
  });
});

describe("Charts page empty and error states", () => {
  it("shows an empty state with a rollup button that refetches", async () => {
    let points = makeDaily({ points: [] });
    const fake = server(() => points);
    const wrapper = await mountPage(fake);
    expect(wrapper.find(".empty-state h2").text()).toBe("No data to chart yet");
    expect(wrapper.find("[data-chart]").exists()).toBe(false);

    points = makeDaily();
    await wrapper.find(".empty-state [data-action='rollup']").trigger("click");
    await flush();
    expect(fake.callsTo("POST", "/api/stats/rollup")).toHaveLength(1);
    expect(fake.callsTo("GET", "/api/stats/daily")).toHaveLength(2);
    expect(fake.callsTo("GET", "/api/stats/summary")).toHaveLength(2);
    expect(wrapper.find(".empty-state").exists()).toBe(false);
    expect(chartIds(wrapper)).toHaveLength(5);
    // Once there is data the rollup button moves to the header.
    expect(wrapper.find(".page-header [data-action='rollup']").exists()).toBe(true);
  });

  it("keeps the page usable when the rollup fails", async () => {
    const fake = server(makeDaily({ points: [] })).on("POST", "/api/stats/rollup", () =>
      apiError(500, "internal error", "internal"),
    );
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-action='rollup']").trigger("click");
    await flush();
    expect(fake.callsTo("GET", "/api/stats/daily")).toHaveLength(1);
    expect(wrapper.find("[data-action='rollup']").attributes("disabled")).toBeUndefined();
  });

  it("shows an error state with a retry when the daily points fail", async () => {
    let fail = true;
    const fake = server(makeDaily()).on("GET", "/api/stats/daily", () =>
      fail ? apiError(500, "internal error", "internal") : json(makeDaily()),
    );
    const wrapper = await mountPage(fake);
    expect(wrapper.find(".error-state h2").text()).toBe("Could not load the chart data");
    fail = false;
    await wrapper.find(".error-state button").trigger("click");
    await flush();
    expect(wrapper.find(".error-state").exists()).toBe(false);
    expect(chartIds(wrapper)).toHaveLength(5);
  });
});

function rangeButton(wrapper: VueWrapper, label: string) {
  const button = wrapper
    .findAll("[data-filter='range'] button")
    .find((candidate) => candidate.text() === label);
  if (button === undefined) throw new Error(`no range ${label}`);
  return button;
}

async function showHourly(wrapper: VueWrapper): Promise<void> {
  await rangeButton(wrapper, "24 hours").trigger("click");
  await flush();
}

const HOURLY_IDS = [
  "hourly-downloads",
  "hourly-bytes",
  "hourly-jobs",
  "hourly-added",
  "hourly-gone",
  "hourly-scrape",
];

describe("Charts page 24 hours view", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers 24 hours as the first range, beside the day ranges", async () => {
    const wrapper = await mountPage(server(makeDaily()));
    expect(wrapper.findAll("[data-filter='range'] button").map((button) => button.text())).toEqual([
      "24 hours",
      "30 days",
      "90 days",
      "365 days",
    ]);
  });

  it("swaps to live hourly charts labelled by local hour", async () => {
    const fake = server(makeDaily());
    const wrapper = await mountPage(fake);
    await showHourly(wrapper);

    const calls = fake.callsTo("GET", "/api/stats/hourly");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query.get("hours")).toBe("24");
    expect(calls[0]!.query.has("location_id")).toBe(false);

    expect(chartIds(wrapper)).toEqual(HOURLY_IDS);
    for (const title of wrapper.findAll("[data-chart] h2").map((heading) => heading.text())) {
      expect(title).toContain("per hour");
    }
    const downloads = chart(wrapper, "hourly-downloads");
    expect(downloads.data.labels?.[0]).toBe(hourLabel(makeHourly().from));
    expect(downloads.data.datasets[0]?.data).toHaveLength(24);
    expect(downloads.data.datasets[0]?.data[0]).toBe(2);
    expect((downloads.options.scales as { x: { title: { text: string } } }).x.title.text).toBe(
      HOUR_AXIS_TITLE,
    );
    expect(chart(wrapper, "hourly-jobs").data.datasets.map((dataset) => dataset.label)).toEqual([
      "Done",
      "Failed",
    ]);

    // No rollup for a live view: a refresh button takes its place.
    expect(wrapper.find("[data-action='rollup']").exists()).toBe(false);
    expect(wrapper.find(".page-header [data-action='refresh']").exists()).toBe(true);
    expect(wrapper.find("[data-hourly-note]").text()).toBe(
      "Storage has no hourly history: 3.00 GB is on disk across every location now. " +
        "API units are only counted per UTC day: 8,500 spent so far today.",
    );
    expect(wrapper.find("details.points-table summary").text()).toBe(
      "Show the data as a table (24 hours)",
    );
  });

  it("goes back to the daily charts", async () => {
    const fake = server(makeDaily());
    const wrapper = await mountPage(fake);
    await showHourly(wrapper);
    await rangeButton(wrapper, "30 days").trigger("click");
    await flush();
    expect(chartIds(wrapper)).toEqual(["storage", "downloads", "catalog", "gone", "api"]);
    expect(fake.callsTo("GET", "/api/stats/daily").at(-1)!.query.get("from")).toBe(
      rangeWindow(30).from,
    );
    expect(wrapper.find(".page-header [data-action='rollup']").exists()).toBe(true);
    expect(wrapper.find("[data-action='refresh']").exists()).toBe(false);
  });

  it("refetches when 24 hours is chosen again or refresh is pressed", async () => {
    const fake = server(makeDaily());
    const wrapper = await mountPage(fake);
    await showHourly(wrapper);
    await showHourly(wrapper);
    expect(fake.callsTo("GET", "/api/stats/hourly")).toHaveLength(2);
    await wrapper.find("[data-action='refresh']").trigger("click");
    await flush();
    expect(fake.callsTo("GET", "/api/stats/hourly")).toHaveLength(3);
    // Re-choosing a day range refetches it too.
    await rangeButton(wrapper, "90 days").trigger("click");
    await flush();
    const daily = fake.callsTo("GET", "/api/stats/daily").length;
    await rangeButton(wrapper, "90 days").trigger("click");
    await flush();
    expect(fake.callsTo("GET", "/api/stats/daily")).toHaveLength(daily + 1);
  });

  it("refreshes itself while open and stops when left or unmounted", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fake = server(makeDaily());
    const wrapper = await mountPage(fake);
    vi.advanceTimersByTime(HOURLY_REFRESH_MS);
    await flush();
    expect(fake.callsTo("GET", "/api/stats/hourly")).toHaveLength(0);

    await showHourly(wrapper);
    vi.advanceTimersByTime(HOURLY_REFRESH_MS);
    await flush();
    expect(fake.callsTo("GET", "/api/stats/hourly")).toHaveLength(2);

    await rangeButton(wrapper, "30 days").trigger("click");
    await flush();
    vi.advanceTimersByTime(HOURLY_REFRESH_MS * 2);
    await flush();
    expect(fake.callsTo("GET", "/api/stats/hourly")).toHaveLength(2);

    await showHourly(wrapper);
    expect(fake.callsTo("GET", "/api/stats/hourly")).toHaveLength(3);
    wrapper.unmount();
    vi.advanceTimersByTime(HOURLY_REFRESH_MS * 2);
    await flush();
    expect(fake.callsTo("GET", "/api/stats/hourly")).toHaveLength(3);
  });

  it("filters the download charts by location and drops the catalog-wide ones", async () => {
    const fake = server(makeDaily()).on("GET", "/api/stats/hourly", (request) =>
      json(
        makeHourly({
          location_id: Number(request.query.get("location_id") ?? 0),
          bytes_used: 1024,
        }),
      ),
    );
    const wrapper = await mountPage(fake);
    await showHourly(wrapper);
    wrapper.findComponent(Select).vm.$emit("update:modelValue", 2);
    await flush();

    expect(fake.callsTo("GET", "/api/stats/hourly").at(-1)!.query.get("location_id")).toBe("2");
    expect(chartIds(wrapper)).toEqual(["hourly-downloads", "hourly-bytes"]);
    expect(wrapper.find("[data-hourly-note]").text()).toBe(
      "Storage has no hourly history: 1.00 KB is on disk on second now.",
    );
    expect(wrapper.find("[data-location-note]").text()).toContain("scrape requests");
  });

  it("shows an error state with a retry when the hourly points fail", async () => {
    let fail = true;
    const fake = server(makeDaily()).on("GET", "/api/stats/hourly", () =>
      fail ? apiError(500, "internal error", "internal") : json(makeHourly()),
    );
    const wrapper = await mountPage(fake);
    await showHourly(wrapper);
    expect(wrapper.find(".error-state h2").text()).toBe("Could not load the chart data");
    expect(wrapper.find("[data-chart]").exists()).toBe(false);
    fail = false;
    await wrapper.find(".error-state button").trigger("click");
    await flush();
    expect(wrapper.find(".error-state").exists()).toBe(false);
    expect(chartIds(wrapper)).toEqual(HOURLY_IDS);
  });
});
