import { SettingsResponseSchema } from "@cellar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSettings,
  getSettingsOverrides,
  invalidateSettingsCache,
  updateSettings,
} from "../src/domain/settings.ts";
import { DomainError } from "../src/domain/errors.ts";
import { createTempApp, createTempDb, type TempApp, type TempDb } from "./helpers.ts";

describe("settings domain", () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createTempDb();
  });

  afterEach(() => {
    temp.close();
  });

  it("resolves registry defaults when nothing is stored", () => {
    expect(getSettingsOverrides(temp.db)).toEqual({});
    const settings = getSettings(temp.db);
    expect(settings["quota.api_units_per_day"]).toBe(10000);
    expect(settings["tools.pot_provider_url"]).toBe("http://bgutil:4416");
  });

  it("takes the PO token provider default from config unless overridden", () => {
    expect(
      getSettings(temp.db, { potProviderUrl: "http://pot:1234" })["tools.pot_provider_url"],
    ).toBe("http://pot:1234");
    updateSettings(temp.db, { "tools.pot_provider_url": "" });
    expect(
      getSettings(temp.db, { potProviderUrl: "http://pot:1234" })["tools.pot_provider_url"],
    ).toBe("");
  });

  it("stores only changed keys, clears with null and invalidates the cache", () => {
    expect(getSettings(temp.db)["quota.api_units_per_day"]).toBe(10000);
    const overrides = updateSettings(temp.db, { "quota.api_units_per_day": 500 }, 1000);
    expect(overrides).toEqual({ "quota.api_units_per_day": 500 });
    expect(getSettings(temp.db)["quota.api_units_per_day"]).toBe(500);

    // Unchanged value: the row (and its updated_at) is left alone.
    updateSettings(temp.db, { "quota.api_units_per_day": 500, "bulk.warn_gb": 5 }, 2000);
    const rows = temp.db.all<{ key: string; updated_at: number }>(
      "SELECT key, updated_at FROM settings ORDER BY key",
    );
    expect(rows).toEqual([
      { key: "bulk.warn_gb", updated_at: 2000 },
      { key: "quota.api_units_per_day", updated_at: 1000 },
    ]);

    expect(updateSettings(temp.db, { "quota.api_units_per_day": null })).toEqual({
      "bulk.warn_gb": 5,
    });
    expect(getSettings(temp.db)["quota.api_units_per_day"]).toBe(10000);
  });

  it("rejects unknown keys and invalid values with per-field details", () => {
    try {
      updateSettings(temp.db, { "nope.key": 1, "quota.api_units_per_day": -1 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const details = (error as DomainError).details as { fields: Record<string, string> };
      expect(Object.keys(details.fields).sort()).toEqual(["nope.key", "quota.api_units_per_day"]);
    }
  });

  it("ignores stored rows for unknown keys or unparseable JSON", () => {
    temp.db.run("INSERT INTO settings (key, value_json, updated_at) VALUES ('gone.key', '1', 0)");
    temp.db.run(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('bulk.warn_gb', '{bad', 0)",
    );
    invalidateSettingsCache(temp.db);
    expect(getSettingsOverrides(temp.db)).toEqual({});
    expect(getSettings(temp.db)["bulk.warn_gb"]).toBe(20);
  });

  it("hands out copies the caller cannot use to corrupt the cache", () => {
    const first = getSettings(temp.db);
    first["thumbnails.variants"].push("default");
    first["quota.api_units_per_day"] = 1;
    expect(getSettings(temp.db)["quota.api_units_per_day"]).toBe(10000);
    expect(getSettings(temp.db)["thumbnails.variants"]).toHaveLength(6);
  });
});

describe("settings routes", () => {
  let temp: TempApp;

  beforeEach(async () => {
    temp = await createTempApp();
  });

  afterEach(async () => {
    await temp.close();
  });

  it("GET returns the sparse overrides", async () => {
    const res = await temp.app.inject({ method: "GET", url: "/api/settings" });
    expect(res.statusCode).toBe(200);
    expect(SettingsResponseSchema.parse(res.json())).toEqual({ overrides: {} });
  });

  it("PUT applies a patch given directly or wrapped in { patch }", async () => {
    let res = await temp.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { "download.concurrency": 4 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ overrides: { "download.concurrency": 4 } });

    res = await temp.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { patch: { "download.concurrency": null, "bulk.warn_gb": 1 } },
    });
    expect(res.json()).toEqual({ overrides: { "bulk.warn_gb": 1 } });

    res = await temp.app.inject({ method: "GET", url: "/api/settings" });
    expect(res.json()).toEqual({ overrides: { "bulk.warn_gb": 1 } });
  });

  it("PUT rejects invalid patches and cross-key inconsistencies with 400", async () => {
    let res = await temp.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { "download.concurrency": 99 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid", details: { fields: {} } });
    expect(res.json().details.errors).toHaveProperty("download.concurrency");

    res = await temp.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { "reaper.low_water_pct": 99, "reaper.high_water_pct": 50 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.fields).toHaveProperty("reaper.low_water_pct");

    res = await temp.app.inject({ method: "PUT", url: "/api/settings", payload: [1, 2] });
    expect(res.statusCode).toBe(400);
  });

  it("PUT with no body is an empty patch", async () => {
    const res = await temp.app.inject({ method: "PUT", url: "/api/settings" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ overrides: {} });
  });
});
