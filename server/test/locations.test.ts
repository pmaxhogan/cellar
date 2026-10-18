import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { LocationRowSchema, LocationsListResponseSchema } from "@cellar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { firstEnabledLocation, fsFacts, validateContainerPath } from "../src/domain/locations.ts";
import { createTempApp, type TempApp } from "./helpers.ts";

let temp: TempApp;
let mount: string;

function addMedia(locationId: number | null, size: number, current = 1): void {
  temp.db.run(
    `INSERT OR IGNORE INTO videos (id, created_at, updated_at) VALUES ('dQw4w9WgXcQ', 0, 0)`,
  );
  temp.db.run(
    `INSERT INTO media (video_id, kind, is_current, location_id, rel_path, size_bytes, created_at)
     VALUES ('dQw4w9WgXcQ', 'video', ?, ?, 'a.webm', ?, 0)`,
    current,
    locationId,
    size,
  );
}

async function create(payload: Record<string, unknown>) {
  return temp.app.inject({ method: "POST", url: "/api/locations", payload });
}

beforeEach(async () => {
  temp = await createTempApp();
  mount = mkdtempSync(join(tmpdir(), "cellar-mount-"));
});

afterEach(async () => {
  await temp.close();
  rmSync(mount, { recursive: true, force: true });
});

describe("locations routes", () => {
  it("lists the seeded /media row even when it is not mounted", async () => {
    const res = await temp.app.inject({ method: "GET", url: "/api/locations" });
    const { rows } = LocationsListResponseSchema.parse(res.json());
    expect(rows[0]).toMatchObject({ label: "media", container_path: "/media", used_bytes: 0 });
    if (process.platform === "win32") {
      expect(rows[0]?.mounted).toBe(false);
    }
  });

  it("creates a location on an existing directory with live facts", async () => {
    const off = join(mount, "off");
    mkdirSync(off);
    const disabled = await create({ label: "off", container_path: off, enabled: false });
    expect(disabled.json()).toMatchObject({ enabled: false });
    const res = await create({ label: "big", container_path: `${mount}/`, quota_bytes: 1000 });
    expect(res.statusCode).toBe(201);
    const row = LocationRowSchema.parse(res.json());
    expect(row).toMatchObject({
      label: "big",
      container_path: mount,
      quota_bytes: 1000,
      enabled: true,
      mounted: true,
      used_bytes: 0,
    });
    expect(row.fs_free_bytes).toBeGreaterThan(0);
  });

  it("rejects relative, missing, file and data-dir paths", async () => {
    const file = join(mount, "file.txt");
    writeFileSync(file, "x");
    for (const container_path of [
      "relative/path",
      join(mount, "missing"),
      file,
      temp.config.dataDir,
      join(temp.config.dataDir, "sub"),
    ]) {
      const res = await create({ label: `x${String(Math.random())}`, container_path });
      expect(res.statusCode).toBe(400);
      expect(res.json().details.fields).toHaveProperty("container_path");
    }
  });

  it("rejects a path that contains the data directory", () => {
    expect(() => validateContainerPath({ dataDir: join(mount, "data") }, mount)).toThrow(
      /data directory/,
    );
    expect(validateContainerPath({ dataDir: join(tmpdir(), "elsewhere") }, mount)).toBe(mount);
    expect(() => validateContainerPath({ dataDir: parse(mount).root }, mount)).toThrow(
      /data directory/,
    );
  });

  it("answers 409 on a duplicate label or path", async () => {
    const second = join(mount, "second");
    mkdirSync(second);
    expect((await create({ label: "one", container_path: mount })).statusCode).toBe(201);
    expect((await create({ label: "one", container_path: second })).statusCode).toBe(409);
    expect((await create({ label: "two", container_path: mount })).statusCode).toBe(409);
  });

  it("updates fields, and refuses to move a path that holds files", async () => {
    const id = LocationRowSchema.parse(
      (await create({ label: "a", container_path: mount })).json(),
    ).id;
    let res = await temp.app.inject({
      method: "PUT",
      url: `/api/locations/${String(id)}`,
      payload: { label: "renamed", enabled: false, quota_bytes: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ label: "renamed", enabled: false, quota_bytes: 5 });

    const other = join(mount, "other");
    mkdirSync(other);
    res = await temp.app.inject({
      method: "PATCH",
      url: `/api/locations/${String(id)}`,
      payload: { container_path: other },
    });
    expect(res.json().container_path).toBe(other);

    addMedia(id, 10);
    res = await temp.app.inject({
      method: "PUT",
      url: `/api/locations/${String(id)}`,
      payload: { container_path: mount },
    });
    expect(res.statusCode).toBe(409);
    // Re-stating the same path is fine.
    res = await temp.app.inject({
      method: "PUT",
      url: `/api/locations/${String(id)}`,
      payload: { container_path: other, enabled: true },
    });
    expect(res.statusCode).toBe(200);

    res = await temp.app.inject({
      method: "PUT",
      url: `/api/locations/${String(id)}`,
      payload: { label: "media" },
    });
    expect(res.statusCode).toBe(409);
    res = await temp.app.inject({ method: "PUT", url: "/api/locations/999", payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it("reports usage from current media only", async () => {
    const id = LocationRowSchema.parse(
      (await create({ label: "u", container_path: mount, quota_bytes: 100 })).json(),
    ).id;
    addMedia(id, 40);
    addMedia(id, 2, 1);
    addMedia(id, 1000, 0);
    addMedia(null, 7);
    const res = await temp.app.inject({ method: "GET", url: `/api/locations/${String(id)}/usage` });
    expect(res.statusCode).toBe(200);
    const usage = res.json();
    expect(usage).toMatchObject({ used_bytes: 42, quota_bytes: 100, mounted: true });
    expect(usage.fs_total_bytes).toBeGreaterThanOrEqual(usage.fs_free_bytes);

    const list = LocationsListResponseSchema.parse(
      (await temp.app.inject({ method: "GET", url: "/api/locations" })).json(),
    );
    expect(list.rows.find((row) => row.id === id)?.used_bytes).toBe(42);
    expect(
      (await temp.app.inject({ method: "GET", url: "/api/locations/999/usage" })).statusCode,
    ).toBe(404);
  });

  it("deletes an empty location and refuses one that holds files", async () => {
    const id = LocationRowSchema.parse(
      (await create({ label: "d", container_path: mount })).json(),
    ).id;
    addMedia(id, 1, 0);
    let res = await temp.app.inject({ method: "DELETE", url: `/api/locations/${String(id)}` });
    expect(res.statusCode).toBe(409);
    temp.db.run("DELETE FROM media");
    res = await temp.app.inject({ method: "DELETE", url: `/api/locations/${String(id)}` });
    expect(res.statusCode).toBe(204);
    res = await temp.app.inject({ method: "DELETE", url: `/api/locations/${String(id)}` });
    expect(res.statusCode).toBe(404);
  });
});

describe("location helpers", () => {
  it("firstEnabledLocation picks the lowest enabled id", () => {
    expect(firstEnabledLocation(temp.db)).toMatchObject({ id: 1, container_path: "/media" });
    temp.db.run("UPDATE locations SET enabled = 0");
    expect(firstEnabledLocation(temp.db)).toBeNull();
  });

  it("fsFacts never throws for a missing path", () => {
    expect(fsFacts(join(mount, "nope"))).toEqual({
      mounted: false,
      fs_free_bytes: null,
      fs_total_bytes: null,
    });
    expect(fsFacts(mount).mounted).toBe(true);
  });
});
