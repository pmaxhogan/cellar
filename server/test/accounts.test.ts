import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountRowSchema, AccountsListResponseSchema } from "@cellar/shared";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  markAuthLost,
  markCookiesInvalid,
  readSecret,
  settleAfterCookies,
  settleAfterOAuth,
  storeSecret,
} from "../src/domain/accountStore.ts";
import {
  checkAccountApi,
  checkAccountCookies,
  looksLikeNetscapeCookies,
  normalizeCookies,
  withCookiesFile,
} from "../src/domain/accounts.ts";
import type { ServiceDeps } from "../src/domain/deps.ts";
import { resetToolProbeCache } from "../src/media/exec.ts";
import { scrapeUsage } from "../src/youtube/quota.ts";
import type { TempApp } from "./helpers.ts";
import {
  createWave1App,
  FakeGoogle,
  fixture,
  jsonResponse,
  seedLinkedAccount,
} from "./wave1aHelpers.ts";

const JAR = [
  "# Netscape HTTP Cookie File",
  ".youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tsecret-sid-value",
  ".youtube.com\tTRUE\t/\tTRUE\t0\tPREF\tf6=40000000",
  "",
].join("\n");

let temp: TempApp;
let google: FakeGoogle;

function deps(): ServiceDeps {
  return { config: temp.config, db: temp.db, log: temp.app.log, fetch: google.fetch };
}

function postCookies(id: number, cookies: unknown) {
  return temp.app.inject({
    method: "POST",
    url: `/api/accounts/${String(id)}/cookies`,
    payload: { cookies },
  });
}

beforeEach(async () => {
  resetToolProbeCache();
  google = await new FakeGoogle().init();
  temp = await createWave1App({}, { fetch: google.fetch });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await temp.close();
});

describe("accounts CRUD", () => {
  it("creates, lists, edits and deletes", async () => {
    let res = await temp.app.inject({ method: "GET", url: "/api/accounts" });
    expect(AccountsListResponseSchema.parse(res.json())).toEqual({ rows: [] });

    res = await temp.app.inject({
      method: "POST",
      url: "/api/accounts",
      payload: { label: "  Main  " },
    });
    expect(res.statusCode).toBe(201);
    const row = AccountRowSchema.parse(res.json());
    expect(row).toMatchObject({ label: "Main", status: "pending", has_cookies: false });

    res = await temp.app.inject({
      method: "PUT",
      url: `/api/accounts/${String(row.id)}`,
      payload: { label: "Renamed", scrape_budget_per_hour: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ label: "Renamed", scrape_budget_per_hour: 10 });
    expect(
      temp.db.get<{ b: number }>(
        "SELECT scrape_budget_per_hour AS b FROM accounts WHERE id = ?",
        row.id,
      )?.b,
    ).toBe(10);

    res = await temp.app.inject({
      method: "PATCH",
      url: `/api/accounts/${String(row.id)}`,
      payload: { scrape_budget_per_hour: null },
    });
    expect(res.statusCode).toBe(200);
    expect(AccountRowSchema.parse(res.json()).scrape_budget_per_hour).toBeNull();

    res = await temp.app.inject({ method: "DELETE", url: `/api/accounts/${String(row.id)}` });
    expect(res.statusCode).toBe(204);
    res = await temp.app.inject({ method: "DELETE", url: `/api/accounts/${String(row.id)}` });
    expect(res.statusCode).toBe(404);
  });

  it("creates with an empty label when none is given", async () => {
    const res = await temp.app.inject({ method: "POST", url: "/api/accounts", payload: {} });
    expect(res.statusCode).toBe(201);
    expect(res.json().label).toBe("");
  });

  it("reads an unknown stored status (the migration default) as pending", async () => {
    temp.db.run("INSERT INTO accounts (label, created_at, updated_at) VALUES ('legacy', 0, 0)");
    const res = await temp.app.inject({ method: "GET", url: "/api/accounts" });
    expect(AccountsListResponseSchema.parse(res.json()).rows[0]?.status).toBe("pending");
  });

  it("only lets the owner pause and resume; resume derives the real status", async () => {
    const id = seedLinkedAccount(temp.db, { status: "ok" });
    let res = await temp.app.inject({
      method: "PUT",
      url: `/api/accounts/${String(id)}`,
      payload: { status: "ok" },
    });
    expect(res.statusCode).toBe(400);

    res = await temp.app.inject({
      method: "PUT",
      url: `/api/accounts/${String(id)}`,
      payload: { status: "disabled" },
    });
    expect(res.json().status).toBe("disabled");

    // Grant but no validated jar: resumes as pending.
    res = await temp.app.inject({
      method: "PUT",
      url: `/api/accounts/${String(id)}`,
      payload: { status: "pending" },
    });
    expect(res.json().status).toBe("pending");

    storeSecret(temp.config, temp.db, id, "cookies", JAR, Date.now());
    temp.db.run("UPDATE accounts SET last_cookie_ok_at = 1, status = 'disabled' WHERE id = ?", id);
    res = await temp.app.inject({
      method: "PUT",
      url: `/api/accounts/${String(id)}`,
      payload: { status: "pending" },
    });
    expect(res.json().status).toBe("ok");

    // A credential failure survives a resume.
    temp.db.run("UPDATE accounts SET status = 'cookies_invalid' WHERE id = ?", id);
    res = await temp.app.inject({
      method: "PUT",
      url: `/api/accounts/${String(id)}`,
      payload: { status: "pending" },
    });
    expect(res.json().status).toBe("cookies_invalid");
  });

  it("validates bodies and ids", async () => {
    let res = await temp.app.inject({
      method: "POST",
      url: "/api/accounts",
      payload: { label: "x", extra: 1 },
    });
    expect(res.statusCode).toBe(400);
    res = await temp.app.inject({ method: "PUT", url: "/api/accounts/0", payload: {} });
    expect(res.statusCode).toBe(400);
    res = await temp.app.inject({ method: "PUT", url: "/api/accounts/77", payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it("delete cascades the secrets and per-account channel sources", async () => {
    const id = seedLinkedAccount(temp.db);
    storeSecret(temp.config, temp.db, id, "cookies", JAR, 0);
    temp.db.run(
      "INSERT INTO channels (id, first_seen_at, created_at, updated_at) VALUES ('UCx', 0, 0, 0)",
    );
    temp.db.run(
      `INSERT INTO channel_sources (channel_id, account_id, kind, created_at)
       VALUES ('UCx', ?, 'subscription', 0)`,
      id,
    );
    await temp.app.inject({ method: "DELETE", url: `/api/accounts/${String(id)}` });
    expect(temp.db.all("SELECT * FROM account_secrets")).toEqual([]);
    expect(temp.db.all("SELECT * FROM channel_sources")).toEqual([]);
  });
});

describe("cookie jars", () => {
  it("recognises Netscape jars", () => {
    expect(looksLikeNetscapeCookies(JAR)).toBe(true);
    expect(looksLikeNetscapeCookies("# HTTP Cookie File\n")).toBe(true);
    expect(looksLikeNetscapeCookies(".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tv")).toBe(true);
    expect(looksLikeNetscapeCookies("#HttpOnly_.m.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tv")).toBe(
      true,
    );
    expect(looksLikeNetscapeCookies(".google.com\tTRUE\t/\tTRUE\t0\tSID\tv")).toBe(false);
    expect(looksLikeNetscapeCookies(".notyoutube.com\tTRUE\t/\tTRUE\t0\tSID\tv")).toBe(false);
    expect(looksLikeNetscapeCookies("SID=abc; HSID=def")).toBe(false);
    expect(looksLikeNetscapeCookies('[{"name":"SID"}]')).toBe(false);
    expect(looksLikeNetscapeCookies("\tTRUE\t/\tTRUE\t0\tSID\tv")).toBe(false);
  });

  it("normalises line endings and adds the header yt-dlp requires", () => {
    const bom = String.fromCharCode(0xfeff);
    expect(normalizeCookies(`${bom}.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tv\r\n`)).toBe(
      "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tv\n",
    );
    expect(normalizeCookies("# Netscape HTTP Cookie File")).toBe("# Netscape HTTP Cookie File\n");
  });

  it("stores the jar encrypted, validates it with yt-dlp and writes the rotated jar back", async () => {
    const record = join(temp.dir, "argv.jsonl");
    vi.stubEnv("FAKE_YTDLP_RECORD", record);
    const id = seedLinkedAccount(temp.db, { status: "pending" });

    const res = await postCookies(id, JAR.replace(/\n/g, "\r\n"));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.validation).toEqual({ ok: true, detail: expect.stringMatching(/readable/) });
    expect(AccountRowSchema.parse(body.account)).toMatchObject({
      has_cookies: true,
      status: "ok",
    });
    expect(body.account.last_cookie_ok_at).toEqual(expect.any(Number));
    expect(JSON.stringify(body)).not.toContain("secret-sid-value");

    // At rest the jar is ciphertext only.
    const raw = temp.db.get<{ ciphertext: Uint8Array }>(
      "SELECT ciphertext FROM account_secrets WHERE account_id = ? AND kind = 'cookies'",
      id,
    );
    expect(Buffer.from(raw?.ciphertext ?? []).toString("latin1")).not.toContain("secret-sid");

    // The shim rotated the jar; the refreshed jar was re-encrypted.
    const stored = readSecret(temp.config, temp.db, id, "cookies")?.plaintext ?? "";
    expect(stored).toContain("FAKE_ROTATED_1");
    expect(stored).toContain("secret-sid-value");
    expect(stored).not.toContain("\r");

    // yt-dlp got the history probe and a path, never the jar contents.
    const argv = readFileSync(record, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
      .find((args) => args.includes("--cookies"));
    expect(argv).toEqual(
      expect.arrayContaining([
        "https://www.youtube.com/feed/history",
        "--flat-playlist",
        "--playlist-end",
        "1",
        "-J",
      ]),
    );
    expect(JSON.stringify(argv)).not.toContain("secret-sid-value");
    const cookiePath = argv?.[argv.indexOf("--cookies") + 1] ?? "";
    expect(cookiePath.startsWith(temp.config.tmpDir)).toBe(true);
    expect(existsSync(cookiePath)).toBe(false);
    expect(readdirSync(temp.config.tmpDir)).toEqual([]);
    expect(scrapeUsage({ db: temp.db }, id).used).toBe(1);
  });

  it("keeps a jar that fails validation and flags the account", async () => {
    vi.stubEnv("FAKE_YTDLP_FAIL", "1");
    const id = seedLinkedAccount(temp.db, { status: "ok" });
    const res = await postCookies(id, JAR);
    expect(res.statusCode).toBe(200);
    expect(res.json().validation.ok).toBe(false);
    expect(res.json().validation.detail).toMatch(/^ERROR: \[youtube:tab\]/);
    expect(res.json().account).toMatchObject({ status: "cookies_invalid", has_cookies: true });
    expect(res.json().account.last_cookie_ok_at).toBeNull();
  });

  it("masks the temp path in yt-dlp's error and caps its length", async () => {
    const scriptDir = mkdtempSync(join(tmpdir(), "cellar-complain-"));
    onTestFinished(() => {
      rmSync(scriptDir, { recursive: true, force: true });
    });
    const script = join(scriptDir, "complain.mjs");
    writeFileSync(
      script,
      [
        "const i = process.argv.indexOf('--cookies');",
        "if (process.argv.includes('--help')) { process.exit(0); }",
        "process.stderr.write(`ERROR: '${process.argv[i + 1]}' looks wrong ${'x'.repeat(400)}\\n`);",
        "process.exit(1);",
      ].join("\n"),
    );
    await temp.close();
    temp = await createWave1App(
      { CELLAR_TOOL_YT_DLP: JSON.stringify([process.execPath, script]) },
      { fetch: google.fetch },
    );
    const id = seedLinkedAccount(temp.db);
    const res = await postCookies(id, JAR);
    const detail: string = res.json().validation.detail;
    expect(detail).toMatch(/^ERROR: '<cookies>' looks wrong x+\.\.\.$/);
    expect(detail).not.toContain(temp.config.tmpDir);
    expect(detail.length).toBeLessThanOrEqual(303);
  });

  it("rejects text that is not a cookies.txt without echoing it", async () => {
    const id = seedLinkedAccount(temp.db);
    const res = await postCookies(id, "SID=topsecret; HSID=abc");
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("topsecret");
    expect(readSecret(temp.config, temp.db, id, "cookies")).toBeNull();
  });

  it("answers 404 for an unknown account and 400 for a missing body", async () => {
    expect((await postCookies(55, JAR)).statusCode).toBe(404);
    const id = seedLinkedAccount(temp.db);
    expect((await postCookies(id, "")).statusCode).toBe(400);
  });

  it("answers 412 when no secret key is configured", async () => {
    const id = seedLinkedAccount(temp.db);
    (temp.config as { secretKey: Buffer | null }).secretKey = null;
    const res = await postCookies(id, JAR);
    expect(res.statusCode).toBe(412);
    expect(res.json().error).toMatch(/CELLAR_SECRET_KEY/);
  });

  it("reports a yt-dlp that cannot start without blaming the jar", async () => {
    await temp.close();
    temp = await createWave1App(
      { CELLAR_TOOL_YT_DLP: JSON.stringify([join("/", "no", "such", "yt-dlp")]) },
      { fetch: google.fetch },
    );
    const id = seedLinkedAccount(temp.db, { status: "ok" });
    const res = await postCookies(id, JAR);
    expect(res.json().validation).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/could not be run/),
    });
    expect(res.json().account.status).toBe("ok");
  });
});

describe("cookie probe edge cases", () => {
  async function withScript(body: string): Promise<number> {
    const scriptDir = mkdtempSync(join(tmpdir(), "cellar-probe-"));
    onTestFinished(() => {
      rmSync(scriptDir, { recursive: true, force: true });
    });
    const script = join(scriptDir, "probe.mjs");
    writeFileSync(script, `if (process.argv.includes("--help")) process.exit(0);\n${body}\n`);
    await temp.close();
    temp = await createWave1App(
      { CELLAR_TOOL_YT_DLP: JSON.stringify([process.execPath, script]) },
      { fetch: google.fetch },
    );
    const id = seedLinkedAccount(temp.db, { status: "ok" });
    storeSecret(temp.config, temp.db, id, "cookies", JAR, 1);
    return id;
  }

  it("reports a silent failure and a non-ERROR last line", async () => {
    let id = await withScript("process.exit(3);");
    expect((await checkAccountCookies(deps(), id)).detail).toBe(
      "yt-dlp failed without an error message",
    );
    id = await withScript('process.stderr.write("WARNING: odd"); process.exit(1);');
    expect((await checkAccountCookies(deps(), id)).detail).toBe("WARNING: odd");
  });

  it("rejects output that is not JSON", async () => {
    const id = await withScript('process.stdout.write("hello");');
    expect(await checkAccountCookies(deps(), id)).toEqual({
      ok: false,
      detail: "yt-dlp returned output that is not JSON.",
    });
    expect(temp.db.get("SELECT status FROM accounts WHERE id = ?", id)).toEqual({
      status: "cookies_invalid",
    });
  });

  it("reports a timeout without blaming the jar", async () => {
    const id = await withScript("setTimeout(() => {}, 20000);");
    expect(await checkAccountCookies(deps(), id, { timeoutMs: 300 })).toEqual({
      ok: false,
      detail: "yt-dlp timed out reading the history feed.",
    });
    expect(temp.db.get("SELECT status FROM accounts WHERE id = ?", id)).toEqual({ status: "ok" });
  });
});

describe("status transitions", () => {
  it("never overrides disabled or auth_lost, and ignores missing accounts", () => {
    const id = seedLinkedAccount(temp.db, { status: "auth_lost" });
    markCookiesInvalid(temp.db, id, 1);
    settleAfterCookies(temp.db, id, 1);
    expect(temp.db.get("SELECT status FROM accounts WHERE id = ?", id)).toEqual({
      status: "auth_lost",
    });
    markAuthLost(temp.db, 999, 1);
    markCookiesInvalid(temp.db, 999, 1);
    settleAfterCookies(temp.db, 999, 1);
    settleAfterOAuth(temp.db, 999, 1);
    expect(temp.db.get("SELECT COUNT(*) AS n FROM accounts")).toEqual({ n: 1 });
  });
});

describe("withCookiesFile", () => {
  it("writes a private temp file, deletes it, and skips write-back of an unchanged jar", async () => {
    const id = seedLinkedAccount(temp.db);
    storeSecret(temp.config, temp.db, id, "cookies", JAR, 5);
    const seen = await withCookiesFile(deps(), id, async (path) => {
      expect(readFileSync(path, "utf8")).toBe(JAR);
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
      return path;
    });
    expect(existsSync(seen)).toBe(false);
    expect(
      temp.db.get<{ u: number }>(
        "SELECT updated_at AS u FROM account_secrets WHERE account_id = ?",
        id,
      )?.u,
    ).toBe(5);
  });

  it("writes back after a failure too, then rethrows", async () => {
    const id = seedLinkedAccount(temp.db);
    storeSecret(temp.config, temp.db, id, "cookies", JAR, 5);
    await expect(
      withCookiesFile(deps(), id, async (path) => {
        writeFileSync(path, `${JAR}.youtube.com\tTRUE\t/\tTRUE\t0\tNEW\tv\n`);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(readSecret(temp.config, temp.db, id, "cookies")?.plaintext).toContain("\tNEW\t");
  });

  it("ignores a jar the tool emptied, mangled or deleted", async () => {
    const id = seedLinkedAccount(temp.db);
    storeSecret(temp.config, temp.db, id, "cookies", JAR, 5);
    await withCookiesFile(deps(), id, async (path) => {
      writeFileSync(path, "");
    });
    await withCookiesFile(deps(), id, async (path) => {
      writeFileSync(path, "garbage");
    });
    await withCookiesFile(deps(), id, async (path) => {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(path);
    });
    expect(readSecret(temp.config, temp.db, id, "cookies")?.plaintext).toBe(JAR);
  });

  it("does not overwrite a jar the owner replaced while the run was going", async () => {
    const id = seedLinkedAccount(temp.db);
    storeSecret(temp.config, temp.db, id, "cookies", JAR, 5);
    await withCookiesFile(deps(), id, async (path) => {
      storeSecret(temp.config, temp.db, id, "cookies", "# Netscape HTTP Cookie File\nNEWER\n", 6);
      writeFileSync(path, `${JAR}.youtube.com\tTRUE\t/\tTRUE\t0\tROT\tv\n`);
    });
    expect(readSecret(temp.config, temp.db, id, "cookies")?.plaintext).toContain("NEWER");
  });

  it("refuses an account without a jar", async () => {
    const id = seedLinkedAccount(temp.db);
    await expect(withCookiesFile(deps(), id, async () => 1)).rejects.toThrow(/no cookie jar/);
  });
});

describe("health probes", () => {
  it("checkAccountCookies reports a missing jar and a missing account", async () => {
    const id = seedLinkedAccount(temp.db);
    expect(await checkAccountCookies(deps(), id)).toEqual({
      ok: false,
      detail: "No cookie jar is stored for this account.",
    });
    await expect(checkAccountCookies(deps(), 999)).rejects.toThrow(/does not exist/);
  });

  it("checkAccountApi runs channels.list mine", async () => {
    const id = seedLinkedAccount(temp.db);
    expect(await checkAccountApi(deps(), id)).toEqual({
      ok: true,
      detail: "Token valid; channel UCFakeAccountChannel0001.",
    });
    expect(google.apiCalls()[0]?.url.searchParams.get("part")).toBe("id");
    google.api["channels"] = () => jsonResponse(200, { items: [] });
    expect((await checkAccountApi(deps(), id)).detail).toMatch(/no YouTube channel/);
  });

  it("checkAccountApi reports auth loss and other failures as not ok", async () => {
    const id = seedLinkedAccount(temp.db, { refreshToken: "dead" });
    google.revokedRefreshTokens.add("dead");
    const lost = await checkAccountApi(deps(), id);
    expect(lost.ok).toBe(false);
    expect(lost.detail).toMatch(/revoked or has expired/);

    const other = seedLinkedAccount(temp.db);
    google.api["channels"] = () => jsonResponse(500, fixture("error.quotaExceeded.json"));
    expect(await checkAccountApi(deps(), other)).toEqual({
      ok: false,
      detail: "YouTube channels.list failed with HTTP 500 (quotaExceeded).",
    });

    const broken: ServiceDeps = {
      ...deps(),
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    };
    expect(await checkAccountApi(broken, other)).toEqual({ ok: false, detail: "fetch failed" });
    const weird: ServiceDeps = {
      ...deps(),
      fetch: async () => {
        throw Object.create(null) as Error;
      },
    };
    expect(await checkAccountApi(weird, other)).toEqual({
      ok: false,
      detail: "The YouTube API call failed.",
    });
    await expect(checkAccountApi(deps(), 404)).rejects.toThrow(/does not exist/);
  });
});
