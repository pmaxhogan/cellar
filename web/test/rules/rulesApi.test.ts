import { describe, expect, it } from "vitest";
import { matchAll } from "@cellar/shared";
import {
  createRule,
  deleteRule,
  draftFromRow,
  fetchCodecSupport,
  inspectVideo,
  listAccounts,
  listLocations,
  listProxies,
  listRules,
  previewCondition,
  reorderRules,
  searchChannels,
  setVideoOverrides,
  updateRule,
} from "../../src/api/rules.ts";
import { channelDisplay, createRuleLookups } from "../../src/lib/rulesLookups.ts";
import { stubApi } from "../helpers/stubApi.ts";
import { Reply, defaultRows, fakeApi, makeInspect, makeRow } from "./fakeApi.ts";

describe("rules api", () => {
  it("lists, creates, updates, deletes and reorders rules", async () => {
    const rows = defaultRows();
    const fake = fakeApi({
      "GET /api/rules": { rows },
      "POST /api/rules": makeRow({ id: 60 }),
      "PUT /api/rules/60": makeRow({ id: 60, enabled: false }),
      "DELETE /api/rules/60": new Reply(204),
      "PUT /api/rules/order": { rows },
    });
    expect(await listRules(fake.api)).toHaveLength(8);
    const draft = draftFromRow(makeRow());
    expect(draft).toEqual({
      kind: "custom",
      video_id: null,
      position: 1,
      name: "Shorts are temporary",
      enabled: true,
      condition: makeRow().condition,
      effects: { reclaim_priority: 1 },
    });
    expect((await createRule(fake.api, draft)).id).toBe(60);
    expect((await updateRule(fake.api, 60, { ...draft, enabled: false })).enabled).toBe(false);
    await deleteRule(fake.api, 60);
    expect(await reorderRules(fake.api, [3, 2])).toHaveLength(8);
    expect(fake.callsTo("POST /api/rules")[0]?.body).toEqual(draft);
    expect(fake.callsTo("PUT /api/rules/order")[0]?.body).toEqual({ ids: [3, 2] });
  });

  it("previews, inspects and sets overrides", async () => {
    const fake = fakeApi({
      "POST /api/rules/preview": { count: 2, total: 9, sample: [] },
      "GET /api/inspect": makeInspect(),
      "PUT /api/videos/dQw4w9WgXcQ/overrides": makeInspect({ overrides: { include: false } }),
    });
    expect(await previewCondition(fake.api, matchAll())).toEqual({
      count: 2,
      total: 9,
      sample: [],
    });
    expect(fake.calls[0]?.body).toEqual({ condition: matchAll() });
    expect((await inspectVideo(fake.api, "dQw4w9WgXcQ")).known).toBe(true);
    expect(fake.calls[1]?.query.get("id")).toBe("dQw4w9WgXcQ");
    const after = await setVideoOverrides(fake.api, "dQw4w9WgXcQ", { include: false });
    expect(after.overrides).toEqual({ include: false });
    expect(fake.calls[2]?.body).toEqual({ effects: { include: false } });
  });

  it("reads the lookup lists and channel search", async () => {
    const fake = fakeApi({
      "GET /api/channels": (call: { query: URLSearchParams }) => ({
        rows: [
          {
            id: "UCaaaaaaaaaaaaaaaaaaaaaa",
            title: `match ${call.query.get("q")}`,
            handle: null,
            thumbnail_url: null,
            subscribed: true,
            manual: false,
            video_count: 3,
          },
        ],
        total: 1,
        page: 1,
        perPage: 10,
      }),
      "GET /api/locations": { rows: [] },
      "GET /api/accounts": { rows: [] },
      "GET /api/proxies": { rows: [] },
    });
    const channels = await searchChannels(fake.api, "abc");
    expect(channels[0]?.title).toBe("match abc");
    expect(fake.calls[0]?.query.get("limit")).toBe("10");
    expect(await listLocations(fake.api)).toEqual([]);
    expect(await listAccounts(fake.api)).toEqual([]);
    expect(await listProxies(fake.api)).toEqual([]);
  });

  it("treats a stubbed client's undefined responses as empty lists", async () => {
    const api = stubApi();
    expect(await listRules(api)).toEqual([]);
    expect(await reorderRules(api, [1])).toEqual([]);
    expect(await searchChannels(api, "x")).toEqual([]);
    expect(await listLocations(api)).toEqual([]);
    expect(await listAccounts(api)).toEqual([]);
    expect(await listProxies(api)).toEqual([]);
  });

  it("feature-detects NVENC from the status response", async () => {
    const support = async (body: unknown) =>
      fetchCodecSupport(fakeApi({ "GET /api/status": body }).api);
    expect(await support({ version: "x" })).toEqual({});
    expect(await support({ gpu: null })).toEqual({});
    expect(await support({ gpu: { nvenc: null } })).toEqual({});
    expect(await support({ gpu: { nvenc: false } })).toEqual({
      hevc_nvenc: false,
      h264_nvenc: false,
      av1_nvenc: false,
    });
    expect(await support({ gpu: { nvenc: { hevc: true, h264: false } } })).toEqual({
      hevc_nvenc: true,
      h264_nvenc: false,
      av1_nvenc: undefined,
    });
    expect(await fetchCodecSupport(fakeApi().api)).toEqual({});
  });
});

describe("rule lookups", () => {
  it("loads each list once and labels ids", async () => {
    const fake = fakeApi({
      "GET /api/locations": {
        rows: [
          {
            id: 1,
            label: "NAS",
            container_path: "/media/a",
            quota_bytes: 0,
            enabled: true,
            used_bytes: 0,
            fs_free_bytes: null,
            mounted: true,
            created_at: 1,
            updated_at: 1,
          },
        ],
      },
      "GET /api/accounts": { rows: [] },
      "GET /api/proxies": new Reply(500, { error: "boom" }),
      "GET /api/status": { gpu: { nvenc: false } },
      "GET /api/channels": {
        rows: [
          {
            id: "UCbbbbbbbbbbbbbbbbbbbbbb",
            title: null,
            handle: "@bee",
            thumbnail_url: null,
            subscribed: false,
            manual: true,
            video_count: 0,
          },
        ],
        total: 1,
        page: 1,
        perPage: 10,
      },
    });
    const lookups = createRuleLookups(fake.api);
    await Promise.all([lookups.ensureLocations(), lookups.ensureLocations()]);
    await lookups.ensureLocations();
    expect(fake.callsTo("GET /api/locations")).toHaveLength(1);
    expect(lookups.labels.value.locations?.get(1)).toBe("NAS");
    await lookups.ensureAccounts();
    await lookups.ensureCodecs();
    expect(lookups.codecs.value.hevc_nvenc).toBe(false);
    // A failed load is retried on the next ensure.
    await lookups.ensureProxies();
    await lookups.ensureProxies();
    expect(fake.callsTo("GET /api/proxies")).toHaveLength(2);
    await lookups.searchChannels("bee");
    expect(lookups.labels.value.channels?.get("UCbbbbbbbbbbbbbbbbbbbbbb")).toBe("@bee");
    expect(channelDisplay({ id: "UCx", title: null, handle: null })).toBe("UCx");
  });
});
