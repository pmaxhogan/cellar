import { defineComponent, h, type PropType } from "vue";
import type {
  StatsDailyPoint,
  StatsDailyResponse,
  StatsHourlyPoint,
  StatsHourlyResponse,
  StatsSummary,
} from "@cellar/shared";

/** A stand-in for PrimeVue's Chart: happy-dom has no canvas, and tests want the config. */
export const ChartStub = defineComponent({
  props: {
    type: { type: String, required: true },
    data: { type: Object as PropType<{ datasets: { label?: string }[] }>, required: true },
    options: { type: Object, required: true },
    canvasProps: { type: Object, default: null },
  },
  setup(props) {
    return () =>
      h("div", {
        "data-chart-stub": props.type,
        "data-datasets": props.data.datasets.map((dataset) => dataset.label ?? "").join("|"),
      });
  },
});

export function point(day: string, locationId: number, values: Partial<StatsDailyPoint> = {}) {
  return {
    day,
    location_id: locationId,
    bytes_used: 0,
    downloads: 0,
    catalog: 0,
    gone: 0,
    api_units: 0,
    ...values,
  };
}

export function makeDaily(overrides: Partial<StatsDailyResponse> = {}): StatsDailyResponse {
  return {
    from: "2026-10-16",
    to: "2026-10-18",
    points: [
      point("2026-10-16", 0, {
        bytes_used: 300,
        downloads: 1,
        catalog: 10,
        gone: 1,
        api_units: 40,
      }),
      point("2026-10-16", 1, { bytes_used: 200, downloads: 1, catalog: 4 }),
      point("2026-10-16", 2, { bytes_used: 100, catalog: 2 }),
      point("2026-10-18", 0, {
        bytes_used: 900,
        downloads: 3,
        catalog: 12,
        gone: 2,
        api_units: 90,
      }),
      point("2026-10-18", 1, { bytes_used: 600, downloads: 2, catalog: 6 }),
      point("2026-10-18", 2, { bytes_used: 300, downloads: 1, catalog: 3 }),
    ],
    locations: [
      { id: 1, label: "media" },
      { id: 2, label: "second" },
    ],
    ...overrides,
  };
}

export function makeSummary(overrides: Partial<StatsSummary> = {}): StatsSummary {
  return {
    videos: 1234,
    downloaded: 800,
    gone: 7,
    bytes_by_location: [
      { id: 1, label: "media", enabled: true, bytes_used: 950 * 1024 ** 3, quota_bytes: 1024 ** 4 },
      { id: 2, label: "second", enabled: true, bytes_used: 1024 ** 3, quota_bytes: 0 },
      { id: 3, label: "cold", enabled: false, bytes_used: 0, quota_bytes: 0 },
    ],
    api_units_today: 8500,
    api_units_budget: 10_000,
    downloads_7d: 21,
    downloads_30d: 90,
    ...overrides,
  };
}

export const HOURLY_FROM = Date.UTC(2026, 10, 17, 13);
const HOUR = 3_600_000;

export function hourPoint(index: number, values: Partial<StatsHourlyPoint> = {}): StatsHourlyPoint {
  return {
    hour: HOURLY_FROM + index * HOUR,
    downloads: 0,
    download_bytes: 0,
    jobs_done: 0,
    jobs_failed: 0,
    videos_added: 0,
    videos_gone: 0,
    scrape_requests: 0,
    ...values,
  };
}

/** 24 hours, all zero except hour 0 and the last (current) hour. */
export function makeHourly(overrides: Partial<StatsHourlyResponse> = {}): StatsHourlyResponse {
  const points = Array.from({ length: 24 }, (_, index) => hourPoint(index));
  points[0] = hourPoint(0, {
    downloads: 2,
    download_bytes: 2048,
    jobs_done: 3,
    jobs_failed: 1,
    videos_added: 5,
    videos_gone: 1,
    scrape_requests: 7,
  });
  points[23] = hourPoint(23, { downloads: 1, download_bytes: 1024, jobs_done: 1 });
  return {
    hours: 24,
    from: HOURLY_FROM,
    to: HOURLY_FROM + 24 * HOUR,
    location_id: 0,
    points,
    bytes_used: 3 * 1024 ** 3,
    api_units_today: 8500,
    locations: [
      { id: 1, label: "media" },
      { id: 2, label: "second" },
    ],
    ...overrides,
  };
}
