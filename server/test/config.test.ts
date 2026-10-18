import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, ensureDataDirs, loadConfig } from "../src/config.ts";

const cfEnv = {
  CF_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
  CF_ACCESS_AUD: "a".repeat(64),
  CF_ACCESS_ALLOWED_EMAILS: "owner@example.com",
};

const insecure = { INSECURE_ALLOW_PUBLIC_ACCESS: "1", DATA_DIR: "/d" };

describe("loadConfig - authentication gate", () => {
  it("boots when Cloudflare Access is fully configured", () => {
    const config = loadConfig({ ...cfEnv, DATA_DIR: "/data" });
    expect(config.insecureMode).toBe(false);
    expect(config.host).toBe("0.0.0.0");
    expect(config.cfAccess?.teamDomain).toBe("example.cloudflareaccess.com");
    expect(config.cfAccess?.allowedEmails).toEqual(["owner@example.com"]);
  });

  it("refuses to boot with no auth and no insecure flag", () => {
    expect(() => loadConfig({ DATA_DIR: "/data" })).toThrow(ConfigError);
    expect(() => loadConfig({ DATA_DIR: "/data" })).toThrow(/Cloudflare Access is not configured/);
  });

  it("refuses to boot when Cloudflare Access is only partly configured", () => {
    expect(() =>
      loadConfig({ DATA_DIR: "/data", CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...cfEnv, CF_ACCESS_ALLOWED_EMAILS: ",", DATA_DIR: "/data" }),
    ).toThrow(ConfigError);
  });

  it("treats a blank value as unset and says what is missing", () => {
    // The shipped .env leaves CF_ACCESS_AUD blank until the owner fills it in.
    expect(() => loadConfig({ ...cfEnv, CF_ACCESS_AUD: "", DATA_DIR: "/data" })).toThrow(
      /Cloudflare Access is not configured/,
    );
    expect(() =>
      loadConfig({ ...cfEnv, CF_ACCESS_ALLOWED_EMAILS: "  ", DATA_DIR: "/data" }),
    ).toThrow(/Cloudflare Access is not configured/);
  });

  it("lowercases and trims the allowed email list", () => {
    const config = loadConfig({
      ...cfEnv,
      CF_ACCESS_ALLOWED_EMAILS: " Alice@Example.com , bob@example.com ,",
      DATA_DIR: "/data",
    });
    expect(config.cfAccess?.allowedEmails).toEqual(["alice@example.com", "bob@example.com"]);
  });
});

describe("loadConfig - insecure mode", () => {
  it("binds loopback only, overriding HOST", () => {
    const config = loadConfig({ ...insecure, HOST: "0.0.0.0" });
    expect(config.insecureMode).toBe(true);
    expect(config.host).toBe("127.0.0.1");
    expect(config.cfAccess).toBeNull();
  });

  it("ignores Cloudflare Access settings when insecure mode is on", () => {
    const config = loadConfig({ ...cfEnv, INSECURE_ALLOW_PUBLIC_ACCESS: "true", DATA_DIR: "/d" });
    expect(config.insecureMode).toBe(true);
    expect(config.cfAccess).toBeNull();
  });

  it("treats 0, false, and absent as off", () => {
    expect(() => loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "0", DATA_DIR: "/d" })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "false", DATA_DIR: "/d" })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "", DATA_DIR: "/d" })).toThrow(
      ConfigError,
    );
  });

  it("rejects a value that is neither truthy nor falsy", () => {
    expect(() => loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "maybe", DATA_DIR: "/d" })).toThrow(
      ConfigError,
    );
  });
});

describe("loadConfig - derived directories", () => {
  it("derives state, logs, bin, meta and tmp from DATA_DIR", () => {
    const config = loadConfig({ ...insecure, DATA_DIR: "/srv/cellar" });
    expect(config.stateDir).toBe(join(config.dataDir, "state"));
    expect(config.logsDir).toBe(join(config.dataDir, "logs"));
    expect(config.binDir).toBe(join(config.dataDir, "bin"));
    expect(config.metaDir).toBe(join(config.dataDir, "meta"));
    expect(config.tmpDir).toBe(join(config.dataDir, "tmp"));
    expect(config.dbPath).toBe(join(config.dataDir, "state", "cellar.db"));
  });

  it("defaults the baseline tool directory to the image location", () => {
    const config = loadConfig(insecure);
    expect(config.baselineBinDir.replaceAll("\\", "/")).toMatch(/\/opt\/cellar\/bin$/);
  });

  it("creates every directory, with state and tmp private to the owner", () => {
    const dir = mkdtempSync(join(tmpdir(), "cellar-dirs-"));
    try {
      const config = loadConfig({ ...insecure, DATA_DIR: join(dir, "data") });
      ensureDataDirs(config);
      ensureDataDirs(config); // idempotent
      for (const path of [
        config.stateDir,
        config.logsDir,
        config.binDir,
        config.metaDir,
        config.tmpDir,
      ]) {
        expect(statSync(path).isDirectory(), path).toBe(true);
      }
      if (process.platform !== "win32") {
        expect(statSync(config.tmpDir).mode & 0o777).toBe(0o700);
        expect(statSync(config.stateDir).mode & 0o777).toBe(0o700);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadConfig - validation", () => {
  it("rejects a malformed secret key without echoing it", () => {
    const attempt = () => loadConfig({ ...insecure, CELLAR_SECRET_KEY: "nope-secret-value" });
    expect(attempt).toThrow(/64 hex characters/);
    expect(attempt).not.toThrow(/nope-secret-value/);
  });

  it("accepts a 64 hex character secret key and decodes it to 32 bytes", () => {
    const config = loadConfig({ ...insecure, CELLAR_SECRET_KEY: "ab".repeat(32) });
    expect(config.secretKey?.length).toBe(32);
  });

  it("leaves the secret key null when blank or absent", () => {
    expect(loadConfig(insecure).secretKey).toBeNull();
    expect(loadConfig({ ...insecure, CELLAR_SECRET_KEY: "" }).secretKey).toBeNull();
  });

  it("rejects an out of range port and a bad log level", () => {
    expect(() => loadConfig({ ...insecure, PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...insecure, LOG_LEVEL: "chatty" })).toThrow(ConfigError);
  });

  it("defaults port, log level, public origin and the PO token provider", () => {
    const config = loadConfig(insecure);
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe("info");
    expect(config.publicOrigin).toBe("http://localhost:8080");
    expect(config.potProviderUrl).toBe("http://bgutil:4416");
    expect(config.google).toBeNull();
    expect(config.nodeEnv).toBe("development");
  });

  it("strips a trailing slash from PUBLIC_ORIGIN and POT_PROVIDER_URL", () => {
    const config = loadConfig({
      ...insecure,
      PUBLIC_ORIGIN: "https://cellar.example.com/",
      POT_PROVIDER_URL: "http://pot:4416/",
    });
    expect(config.publicOrigin).toBe("https://cellar.example.com");
    expect(config.potProviderUrl).toBe("http://pot:4416");
  });

  it("rejects a non http origin", () => {
    expect(() => loadConfig({ ...insecure, PUBLIC_ORIGIN: "ftp://cellar.example.com" })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...insecure, PUBLIC_ORIGIN: "not a url" })).toThrow(ConfigError);
  });

  it("reads the Google client, with the secret optional", () => {
    expect(loadConfig({ ...insecure, GOOGLE_CLIENT_ID: "id-1" }).google).toEqual({
      clientId: "id-1",
      clientSecret: null,
    });
    expect(
      loadConfig({ ...insecure, GOOGLE_CLIENT_ID: "id-1", GOOGLE_CLIENT_SECRET: "s" }).google,
    ).toEqual({ clientId: "id-1", clientSecret: "s" });
    expect(loadConfig({ ...insecure, GOOGLE_CLIENT_ID: "" }).google).toBeNull();
  });
});
