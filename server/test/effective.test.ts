import { addDuration, VideoFactsSchema } from "@cellar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dispatchRuleNotifications,
  emptyFacts,
  evaluateVideo,
  loadEvalContext,
  loadVideoFacts,
  videoFacts,
} from "../src/domain/effective.ts";
import { createRule, ensureDefaultRules, listRules } from "../src/domain/rules.ts";
import { createConsoleLogger } from "../src/logging.ts";
import { createTempDb, type TempDb } from "./helpers.ts";
import {
  addAccount,
  addChannel,
  addMedia,
  addSource,
  addVideo,
  DAY,
  effectiveRow,
  harness,
  NOW,
  vid,
  type Harness,
} from "./rulesFixtures.ts";

const log = createConsoleLogger("silent");

let temp: TempDb;
let h: Harness;
let account: number;

function ruleId(name: string): number {
  const row = listRules(temp.db).find((r) => r.name === name);
  if (row === undefined) throw new Error(`no rule ${name}`);
  return row.id;
}

function pri(id: string): number | undefined {
  evaluateVideo(h.deps, id, h.clock.now);
  return effectiveRow(temp.db, id)?.reclaim_priority;
}

beforeEach(() => {
  temp = createTempDb();
  h = harness(temp.db, temp.dir);
  account = addAccount(temp.db);
  ensureDefaultRules(temp.db, log);
});

afterEach(() => {
  temp.close();
});

describe("videoFacts", () => {
  it("builds facts from videos, channels, sources, current media and active shares", () => {
    addChannel(temp.db, "UCchan", "The Channel");
    const id = addVideo(temp.db, vid("facts"), {
      channel_id: "UCchan",
      tags_json: '["a", 1, "b"]',
      has_av1: 1,
      caption_available: 0,
      views: 42,
    });
    addSource(temp.db, id, "history", NOW - 3 * DAY, account, NOW - DAY);
    addSource(temp.db, id, "subscription", NOW - 5 * DAY, null);
    addMedia(temp.db, id, { kind: "audio", downloaded_at: 5, vcodec: null });
    addMedia(temp.db, id, { kind: "video", version: 1, is_current: 0, downloaded_at: 6 });
    addMedia(temp.db, id, { kind: "video", version: 2, downloaded_at: 7, vcodec: "vp9" });
    addMedia(temp.db, id, { kind: "captions", location_id: null, downloaded_at: 8 });
    const share = (token: string, expires: number | null, revoked: number | null): void => {
      temp.db.run(
        `INSERT INTO share_links (token, video_id, expires_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, 1)`,
        token,
        id,
        expires,
        revoked,
      );
    };
    share("t1", null, null);
    share("t2", NOW + DAY, null);
    share("t3", NOW - DAY, null);
    share("t4", null, NOW - DAY);

    const facts = videoFacts(temp.db, id, NOW);
    expect(() => VideoFactsSchema.parse(facts)).not.toThrow();
    expect(facts).toMatchObject({
      id,
      channel_id: "UCchan",
      channel_title: "The Channel",
      tags: ["a", "b"],
      type: "video",
      privacy: "public",
      has_av1: true,
      caption_available: false,
      has_vp9: null,
      views: 42,
      media: { downloaded_at: 7, location_id: 1, vcodec: "vp9" },
      share_link_count: 2,
    });
    expect(facts?.sources.map((s) => s.source)).toEqual(["history", "subscription"]);
    expect(facts?.sources[0]).toMatchObject({ account_id: account, last_seen_at: NOW - DAY });
  });

  it("coerces unknown enum values and bad tags to null / empty, and falls back to audio", () => {
    const id = addVideo(temp.db, vid("odd"), {
      type: "weird",
      privacy: "strange",
      tags_json: "{not json",
    });
    addMedia(temp.db, id, { kind: "audio", downloaded_at: 9 });
    const facts = videoFacts(temp.db, id);
    expect(facts).toMatchObject({ type: null, privacy: null, tags: [], share_link_count: 0 });
    expect(facts?.media?.downloaded_at).toBe(9);
    expect(videoFacts(temp.db, vid("missing"))).toBeNull();
    expect(loadVideoFacts(temp.db, []).size).toBe(0);
  });

  it("gives empty facts for unknown ids", () => {
    expect(VideoFactsSchema.parse(emptyFacts("abcdefghijk"))).toMatchObject({
      id: "abcdefghijk",
      sources: [],
      media: null,
    });
  });
});

describe("default rule retention, end to end in SQLite", () => {
  const cases: {
    name: string;
    sources: [string, number][];
    privacy?: string;
    upload?: number;
    pri: number;
  }[] = [
    { name: "subscription only, 15 days", sources: [["subscription", 15]], pri: 0 },
    { name: "subscription only, 10 days", sources: [["subscription", 10]], pri: -1 },
    { name: "channel only, 20 days", sources: [["channel", 20]], pri: 0 },
    {
      name: "subscription + channel, earliest 15 days",
      sources: [
        ["subscription", 3],
        ["channel", 15],
      ],
      pri: 0,
    },
    {
      name: "backfill guard: uploaded 60 days ago, seen yesterday",
      sources: [["subscription", 1]],
      upload: 60,
      pri: 0,
    },
    { name: "watched 30 days", sources: [["history", 30]], pri: -1 },
    { name: "watched 70 days", sources: [["history", 70]], pri: 0 },
    {
      name: "watched and subscribed, 30 days: the 2-month window applies",
      sources: [
        ["history", 30],
        ["subscription", 30],
      ],
      pri: -1,
    },
    {
      name: "watched and liked, 100 days: the 2-year window applies",
      sources: [
        ["history", 100],
        ["liked", 100],
      ],
      pri: -1,
    },
    { name: "liked 800 days", sources: [["liked", 800]], pri: 0 },
    {
      name: "liked and in Watch Later, 800 days: forever",
      sources: [
        ["liked", 800],
        ["watch_later", 800],
      ],
      pri: -1,
    },
    { name: "Watch Later 2000 days: forever", sources: [["watch_later", 2000]], pri: -1 },
    {
      name: "unlisted subscription video, 30 days: kept forever",
      sources: [["subscription", 30]],
      privacy: "unlisted",
      pri: -1,
    },
    {
      name: "gone watched video, 100 days: kept forever",
      sources: [["history", 100]],
      privacy: "private",
      pri: -1,
    },
    { name: "no sources at all", sources: [], pri: -1 },
  ];

  for (const [index, c] of cases.entries()) {
    it(c.name, () => {
      const id = addVideo(temp.db, vid(`r${String(index)}`), {
        privacy: c.privacy ?? "public",
        upload_date: NOW - (c.upload ?? 1) * DAY,
      });
      for (const [source, days] of c.sources) {
        addSource(
          temp.db,
          id,
          source,
          NOW - days * DAY,
          source === "subscription" ? null : account,
        );
      }
      expect(pri(id)).toBe(c.pri);
    });
  }

  it("applies English-only captions and the first enabled location", () => {
    const id = addVideo(temp.db, vid("caps"));
    evaluateVideo(h.deps, id, NOW);
    const row = effectiveRow(temp.db, id);
    const effective = JSON.parse(row?.effective_json ?? "{}") as Record<string, unknown>;
    expect(effective["captions"]).toEqual({
      enabled: true,
      languages: ["en"],
      auto_generated: true,
    });
    expect(effective["location_id"]).toBe(1);
    expect(row?.location_id).toBe(1);
    expect(row?.include).toBe(1);
    const provenance = JSON.parse(row?.provenance_json ?? "{}") as Record<string, unknown>;
    expect(provenance["captions"]).toBe(ruleId("Captions: English only"));
    expect(provenance["include"]).toBe("default");
    expect(JSON.parse(row?.matched_rule_ids ?? "[]")).toEqual([
      ruleId("Global defaults"),
      ruleId("Captions: English only"),
    ]);
  });
});

describe("evaluateVideo", () => {
  it("schedules next_eval_at at the soonest age threshold", () => {
    const sub = addVideo(temp.db, vid("next1"));
    addSource(temp.db, sub, "subscription", NOW - 10 * DAY);
    evaluateVideo(h.deps, sub, NOW);
    expect(effectiveRow(temp.db, sub)?.next_eval_at).toBe(NOW + 4 * DAY);

    const watched = addVideo(temp.db, vid("next2"));
    addSource(temp.db, watched, "history", NOW - 30 * DAY, account);
    evaluateVideo(h.deps, watched, NOW);
    expect(effectiveRow(temp.db, watched)?.next_eval_at).toBe(
      addDuration(NOW - 30 * DAY, { months: 2 }),
    );

    const plain = addVideo(temp.db, vid("next3"));
    evaluateVideo(h.deps, plain, NOW);
    expect(effectiveRow(temp.db, plain)?.next_eval_at).toBeNull();
  });

  it("reports changes, publishes video.effective and flips at the threshold", () => {
    const id = addVideo(temp.db, vid("flip"));
    addSource(temp.db, id, "subscription", NOW - 10 * DAY);
    const first = evaluateVideo(h.deps, id, NOW);
    expect(first).toMatchObject({
      changed: true,
      before: null,
      after: { reclaim_priority: -1, location_id: 1, include: true },
    });
    expect(h.seen.filter((e) => e.type === "video.effective")).toHaveLength(1);

    const again = evaluateVideo(h.deps, id, NOW + DAY);
    expect(again.changed).toBe(false);
    expect(h.seen.filter((e) => e.type === "video.effective")).toHaveLength(1);

    const later = evaluateVideo(h.deps, id, NOW + 4 * DAY, { emit: false });
    expect(later).toMatchObject({ changed: true, after: { reclaim_priority: 0 } });
    expect(later.before?.reclaim_priority).toBe(-1);
    expect(h.seen.filter((e) => e.type === "video.effective")).toHaveLength(1);
    expect(effectiveRow(temp.db, id)?.evaluated_at).toBe(NOW + 4 * DAY);
  });

  it("returns nothing for an unknown video", () => {
    expect(evaluateVideo(h.deps, vid("ghost"))).toEqual({
      videoId: vid("ghost"),
      changed: false,
      before: null,
      after: null,
      notifications: [],
    });
  });

  it("substitutes the lowest enabled location, or null when none is enabled", () => {
    temp.db.run(
      `INSERT INTO locations (label, container_path, enabled, created_at, updated_at)
       VALUES ('cold', '/cold', 1, 1, 1)`,
    );
    temp.db.run("UPDATE locations SET enabled = 0 WHERE id = 1");
    const id = addVideo(temp.db, vid("loc"));
    expect(evaluateVideo(h.deps, id, NOW).after?.location_id).toBe(2);
    temp.db.run("UPDATE locations SET enabled = 0");
    const result = evaluateVideo(h.deps, id, NOW);
    expect(result).toMatchObject({ changed: true, after: { location_id: null } });
  });

  it("honours a rule's explicit location and include", () => {
    createRule(
      { db: temp.db, log },
      {
        kind: "custom",
        video_id: null,
        position: 1,
        name: "Shorts elsewhere",
        enabled: true,
        condition: { type: "cond", field: "type", op: "eq", value: "short" },
        effects: { location_id: 7, include: false },
      },
    );
    const id = addVideo(temp.db, vid("short"), { type: "short" });
    expect(evaluateVideo(h.deps, id, NOW).after).toEqual({
      reclaim_priority: -1,
      location_id: 7,
      include: false,
    });
  });
});

describe("rule notifications", () => {
  it("rule 7 fires once when a video goes gone, then never again (max_times 1)", () => {
    const id = addVideo(temp.db, vid("gone"), { title: "Lost tape" });
    const rule7 = ruleId("Notify when a video goes gone");
    expect(evaluateVideo(h.deps, id, NOW).notifications).toEqual([]);

    temp.db.run("UPDATE videos SET privacy = 'removed' WHERE id = ?", id);
    expect(evaluateVideo(h.deps, id, NOW).notifications).toEqual([
      { ruleId: rule7, ruleName: "Notify when a video goes gone", videoId: id, title: "Lost tape" },
    ]);
    // Still gone: no repeat while it keeps matching.
    expect(evaluateVideo(h.deps, id, NOW).notifications).toEqual([]);
    // Back, then gone again: the count is already at max_times.
    temp.db.run("UPDATE videos SET privacy = 'public' WHERE id = ?", id);
    evaluateVideo(h.deps, id, NOW);
    temp.db.run("UPDATE videos SET privacy = 'private' WHERE id = ?", id);
    expect(evaluateVideo(h.deps, id, NOW).notifications).toEqual([]);
    expect(
      temp.db.get(
        "SELECT count FROM rule_notify_counts WHERE rule_id = ? AND video_id = ?",
        rule7,
        id,
      ),
    ).toEqual({ count: 1 });
  });

  it("an unlimited rule fires every time the video starts matching; title falls back to id", () => {
    const rule = createRule(
      { db: temp.db, log },
      {
        kind: "custom",
        video_id: null,
        position: 1,
        name: "Watch for keyword",
        enabled: true,
        condition: { type: "cond", field: "views", op: "gt", value: 100 },
        effects: { notify: { enabled: true, max_times: null } },
      },
    );
    const id = addVideo(temp.db, vid("kw"), { title: null, views: 500 });
    for (let i = 0; i < 3; i += 1) {
      temp.db.run("UPDATE videos SET views = 500 WHERE id = ?", id);
      const result = evaluateVideo(h.deps, id, NOW);
      expect(result.notifications).toEqual([
        { ruleId: rule.id, ruleName: "Watch for keyword", videoId: id, title: id },
      ]);
      temp.db.run("UPDATE videos SET views = 5 WHERE id = ?", id);
      expect(evaluateVideo(h.deps, id, NOW).notifications).toEqual([]);
    }
    expect(temp.db.get("SELECT count FROM rule_notify_counts WHERE rule_id = ?", rule.id)).toEqual({
      count: 3,
    });
  });

  it("dispatches notifications and swallows failures", async () => {
    const pending = [
      { ruleId: 1, ruleName: "R", videoId: "abcdefghijk", title: "T" },
      { ruleId: 2, ruleName: "S", videoId: "abcdefghijk", title: "U" },
    ];
    h.notify.mockRejectedValueOnce(new Error("push down"));
    await dispatchRuleNotifications(h.deps, pending);
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.notify).toHaveBeenLastCalledWith({
      type: "rule_notify",
      title: "S",
      body: "U",
      videoId: "abcdefghijk",
      force: true,
      data: { ruleId: 2 },
    });
  });

  it("loads the pass context with the stored install time", () => {
    const ctx = loadEvalContext(h.deps, 123);
    expect(ctx.installedAt).toBe(NOW - 30 * DAY);
    expect(ctx.firstLocationId).toBe(1);
    temp.db.run("DELETE FROM kv WHERE key = 'installed_at'");
    expect(loadEvalContext(h.deps, 123).installedAt).toBe(123);
  });
});
