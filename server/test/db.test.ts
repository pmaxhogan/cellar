import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, readPragma, type Db } from "../src/db/db.ts";
import { ensureInstalledAt, getKv, INSTALLED_AT_KEY, setKv } from "../src/db/kv.ts";
import { migrate } from "../src/db/migrate.ts";
import { migrations } from "../src/db/migrations.ts";
import { createConsoleLogger } from "../src/logging.ts";

const log = createConsoleLogger("silent");

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cellar-db-"));
  db = openDb(join(dir, "state", "cellar.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("openDb", () => {
  it("creates the parent directory and applies the pragmas", () => {
    expect(readPragma(db, "journal_mode")).toBe("wal");
    expect(readPragma(db, "foreign_keys")).toBe(1);
    expect(readPragma(db, "busy_timeout")).toBe(5000);
    // synchronous FULL is 2.
    expect(readPragma(db, "synchronous")).toBe(2);
  });

  it("opens an in-memory database despite WAL being unavailable there", () => {
    const memory = openDb(":memory:");
    expect(readPragma(memory, "foreign_keys")).toBe(1);
    expect(readPragma(memory, "no_such_pragma")).toBeUndefined();
    memory.close();
  });

  it("round-trips typed helpers", () => {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    const inserted = db.run("INSERT INTO t (name) VALUES (?)", "alpha");
    expect(inserted.changes).toBe(1);
    expect(inserted.lastInsertRowid).toBe(1);
    expect(db.get<{ name: string }>("SELECT name FROM t WHERE id = ?", 1)).toEqual({
      name: "alpha",
    });
    expect(db.all<{ name: string }>("SELECT name FROM t")).toHaveLength(1);
    expect(db.get("SELECT name FROM t WHERE id = ?", 99)).toBeUndefined();
  });
});

describe("tx", () => {
  beforeEach(() => {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  });

  it("commits on success", () => {
    const value = db.tx(() => {
      db.run("INSERT INTO t (name) VALUES (?)", "a");
      return 42;
    });
    expect(value).toBe(42);
    expect(db.all("SELECT * FROM t")).toHaveLength(1);
  });

  it("rolls back on throw", () => {
    expect(() =>
      db.tx(() => {
        db.run("INSERT INTO t (name) VALUES (?)", "a");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.all("SELECT * FROM t")).toHaveLength(0);
  });

  it("nests via savepoints, rolling back only the inner scope", () => {
    db.tx(() => {
      db.run("INSERT INTO t (name) VALUES (?)", "outer");
      try {
        db.tx(() => {
          db.run("INSERT INTO t (name) VALUES (?)", "inner");
          throw new Error("inner failed");
        });
      } catch {
        // The outer transaction survives.
      }
      db.tx(() => {
        db.run("INSERT INTO t (name) VALUES (?)", "second inner");
      });
    });
    expect(db.all<{ name: string }>("SELECT name FROM t ORDER BY id")).toEqual([
      { name: "outer" },
      { name: "second inner" },
    ]);
  });
});

describe("migrate", () => {
  it("applies every migration once and is idempotent", () => {
    const first = migrate(db, log);
    expect(first.applied).toEqual(migrations.map((m) => m.name));
    expect(first.applied).toEqual([
      "001_init",
      "002_jobs_notifications",
      "003_catalog",
      "004_title_changes_index",
    ]);

    const second = migrate(db, log);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(migrations.map((m) => m.name));
    expect(db.all("SELECT * FROM migrations")).toHaveLength(migrations.length);
    // The seed row is not duplicated by a second run.
    expect(db.all("SELECT * FROM locations")).toHaveLength(1);
  });

  it("creates the wave 0 tables", () => {
    migrate(db, log);
    const tables = db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .map((row) => row.name)
      .sort();
    for (const name of [
      "account_secrets",
      "accounts",
      "kv",
      "locations",
      "migrations",
      "settings",
    ]) {
      expect(tables).toContain(name);
    }
    // 002 and 003 (orchestrator-owned): queue, inbox and the catalog with FTS.
    for (const name of [
      "jobs",
      "activity",
      "notifications",
      "proxies",
      "checks",
      "videos",
      "rules",
    ]) {
      expect(tables).toContain(name);
    }
    expect(tables).toContain("videos_fts");
  });

  it("rolls a failing migration back rather than half-applying it", () => {
    const bad = [{ name: "999_bad", sql: "CREATE TABLE ok (id INTEGER); CREATE TABLE ok (id);" }];
    expect(() => migrate(db, log, bad)).toThrow();
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.name);
    expect(tables).not.toContain("ok");
    expect(db.all("SELECT * FROM migrations")).toHaveLength(0);
  });
});

describe("001_init", () => {
  beforeEach(() => {
    migrate(db, log);
  });

  it("seeds the media location as unlimited and enabled, with epoch ms timestamps", () => {
    const rows = db.all<{
      label: string;
      container_path: string;
      quota_bytes: number;
      enabled: number;
      used_bytes: number;
      fs_free_bytes: number | null;
      created_at: number;
      updated_at: number;
    }>("SELECT * FROM locations");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      label: "media",
      container_path: "/media",
      quota_bytes: 0,
      enabled: 1,
      used_bytes: 0,
      fs_free_bytes: null,
    });
    expect(Number.isInteger(row.created_at)).toBe(true);
    // Milliseconds, not seconds: within a minute of now.
    expect(Math.abs(row.created_at - Date.now())).toBeLessThan(60_000);
    expect(row.updated_at).toBe(row.created_at);
  });

  it("cascades account secrets when an account is deleted", () => {
    const accountId = db.run(
      "INSERT INTO accounts (label, created_at, updated_at) VALUES (?, ?, ?)",
      "main",
      1,
      1,
    ).lastInsertRowid;
    const account = db.get<{ status: string; api_quota_reserved: number }>(
      "SELECT status, api_quota_reserved FROM accounts WHERE id = ?",
      accountId,
    );
    expect(account).toEqual({ status: "new", api_quota_reserved: 0 });

    const insertSecret = (kind: string) =>
      db.run(
        `INSERT INTO account_secrets (account_id, kind, ciphertext, iv, tag, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        accountId,
        kind,
        Buffer.from("c"),
        Buffer.alloc(12),
        Buffer.alloc(16),
        1,
      );
    insertSecret("oauth_refresh");
    insertSecret("cookies");
    expect(() => insertSecret("cookies")).toThrow();
    expect(() => insertSecret("password")).toThrow();

    db.run("DELETE FROM accounts WHERE id = ?", accountId);
    expect(db.all("SELECT * FROM account_secrets")).toHaveLength(0);
  });

  it("rejects a secret for an account that does not exist", () => {
    expect(() =>
      db.run(
        `INSERT INTO account_secrets (account_id, kind, ciphertext, iv, tag, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        999,
        "cookies",
        Buffer.from("c"),
        Buffer.alloc(12),
        Buffer.alloc(16),
        1,
      ),
    ).toThrow();
  });

  it("keeps location labels and paths unique and flags boolean", () => {
    const insert = (label: string, path: string, enabled = 1) =>
      db.run(
        `INSERT INTO locations (label, container_path, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        label,
        path,
        enabled,
        1,
        1,
      );
    expect(() => insert("media", "/elsewhere")).toThrow();
    expect(() => insert("other", "/media")).toThrow();
    expect(() => insert("other", "/other", 2)).toThrow();
    expect(() => insert("other", "/other")).not.toThrow();
  });
});

describe("kv", () => {
  beforeEach(() => {
    migrate(db, log);
  });

  it("round-trips JSON values and overwrites on set", () => {
    expect(getKv(db, "k")).toBeUndefined();
    setKv(db, "k", { a: 1 }, 10);
    expect(getKv(db, "k")).toEqual({ a: 1 });
    setKv(db, "k", [1, 2], 20);
    expect(getKv(db, "k")).toEqual([1, 2]);
    expect(db.get("SELECT updated_at FROM kv WHERE key = 'k'")).toEqual({ updated_at: 20 });
  });

  it("reads an unparseable row as absent", () => {
    db.run("INSERT INTO kv (key, value_json, updated_at) VALUES ('bad', '{nope', 1)");
    expect(getKv(db, "bad")).toBeUndefined();
  });

  it("records installed_at once and never overwrites it", () => {
    expect(ensureInstalledAt(db, 1_700_000_000_000)).toBe(1_700_000_000_000);
    // A later boot, and a later migrate run, leave the original alone.
    expect(ensureInstalledAt(db, 1_800_000_000_000)).toBe(1_700_000_000_000);
    migrate(db, log);
    expect(getKv<number>(db, INSTALLED_AT_KEY)).toBe(1_700_000_000_000);
  });

  it("defaults installed_at to the current time in epoch ms", () => {
    const before = Date.now();
    const installedAt = ensureInstalledAt(db);
    expect(installedAt).toBeGreaterThanOrEqual(before);
    expect(installedAt).toBeLessThanOrEqual(Date.now());
  });
});
