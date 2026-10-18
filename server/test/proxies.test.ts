import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ProxiesListResponseSchema, ProxyRowSchema } from "@cellar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProxyDeps } from "../src/domain/proxies.ts";
import {
  defaultProxyProbe,
  listProxiesDecrypted,
  markProxyFailure,
  markProxyOk,
  parseProxyUrl,
  pickProxy,
  PROXY_SKIP_MS,
  testProxy,
} from "../src/domain/proxies.ts";
import type { TempApp } from "./helpers.ts";
import { createWave1App } from "./wave1aHelpers.ts";

const SECRET_URL = "http://alice:hunter2@proxy.example.test:3128/path?q=1";

let temp: TempApp;
let probeCalls: string[];
let probeResult: () => Promise<number>;
let now: number;

function deps(): ProxyDeps {
  return { config: temp.config, db: temp.db, log: temp.app.log, now: () => now };
}

async function add(label: string, url = SECRET_URL, enabled = true): Promise<number> {
  const res = await temp.app.inject({
    method: "POST",
    url: "/api/proxies",
    payload: { label, url, enabled },
  });
  expect(res.statusCode).toBe(201);
  return ProxyRowSchema.parse(res.json()).id;
}

beforeEach(async () => {
  probeCalls = [];
  probeResult = async () => 200;
  now = Date.now();
  temp = await createWave1App(
    {},
    {
      now: () => now,
      proxyProbe: async (url) => {
        probeCalls.push(url);
        return probeResult();
      },
    },
  );
});

afterEach(async () => {
  await temp.close();
});

describe("parseProxyUrl", () => {
  it("redacts to scheme://host:port with scheme default ports", () => {
    expect(parseProxyUrl(SECRET_URL).redacted).toBe("http://proxy.example.test:3128");
    expect(parseProxyUrl("https://u:p@h.test").redacted).toBe("https://h.test:443");
    expect(parseProxyUrl("http://h.test").redacted).toBe("http://h.test:80");
    expect(parseProxyUrl("socks5h://u:p@[::1]").redacted).toBe("socks5h://[::1]:1080");
  });

  it("rejects bad URLs without echoing them", () => {
    expect(() => parseProxyUrl("socks5:///hunter2")).toThrow(/no host/);
    for (const raw of ["not a url hunter2", "ftp://u:hunter2@h.test", "file:///etc/passwd"]) {
      expect(() => parseProxyUrl(raw)).toThrow();
      try {
        parseProxyUrl(raw);
      } catch (error) {
        expect(JSON.stringify(error)).not.toContain("hunter2");
        expect((error as Error).message).not.toContain("hunter2");
      }
    }
  });
});

describe("proxy routes", () => {
  it("stores the URL encrypted and only ever returns the redacted form", async () => {
    const id = await add("one");
    const list = await temp.app.inject({ method: "GET", url: "/api/proxies" });
    expect(ProxiesListResponseSchema.parse(list.json()).rows).toEqual([
      {
        id,
        label: "one",
        url_redacted: "http://proxy.example.test:3128",
        enabled: true,
        fail_count: 0,
        skipped_until: null,
      },
    ]);
    expect(list.body).not.toContain("hunter2");
    const raw = temp.db.get<{ url_blob: Uint8Array }>("SELECT url_blob FROM proxies");
    expect(Buffer.from(raw?.url_blob ?? []).toString("latin1")).not.toContain("hunter2");
    expect(listProxiesDecrypted(deps())[0]?.url).toBe(SECRET_URL);
  });

  it("rejects an invalid URL with 400 and no echo", async () => {
    const res = await temp.app.inject({
      method: "POST",
      url: "/api/proxies",
      payload: { label: "bad", url: "gopher://u:hunter2@x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("hunter2");
  });

  it("answers 409 for a duplicate label and 412 without a secret key", async () => {
    await add("dup");
    const res = await temp.app.inject({
      method: "POST",
      url: "/api/proxies",
      payload: { label: "dup", url: "http://h.test" },
    });
    expect(res.statusCode).toBe(409);
    (temp.config as { secretKey: Buffer | null }).secretKey = null;
    const nokey = await temp.app.inject({
      method: "POST",
      url: "/api/proxies",
      payload: { label: "k", url: "http://h.test" },
    });
    expect(nokey.statusCode).toBe(412);
  });

  it("updates label, enabled and URL (a new URL resets failures)", async () => {
    const id = await add("p");
    markProxyFailure(temp.db, id, now);
    let res = await temp.app.inject({
      method: "PUT",
      url: `/api/proxies/${String(id)}`,
      payload: { label: "q", enabled: false },
    });
    expect(res.json()).toMatchObject({ label: "q", enabled: false, fail_count: 1 });
    res = await temp.app.inject({
      method: "PATCH",
      url: `/api/proxies/${String(id)}`,
      payload: { url: "socks5://bob:pw@s.test:9050", enabled: true },
    });
    expect(res.json()).toMatchObject({
      url_redacted: "socks5://s.test:9050",
      fail_count: 0,
      enabled: true,
      label: "q",
    });
    expect(listProxiesDecrypted(deps())[0]?.url).toBe("socks5://bob:pw@s.test:9050");

    await add("taken", "http://t.test");
    res = await temp.app.inject({
      method: "PUT",
      url: `/api/proxies/${String(id)}`,
      payload: { label: "taken" },
    });
    expect(res.statusCode).toBe(409);
    res = await temp.app.inject({ method: "PUT", url: "/api/proxies/999", payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it("deletes", async () => {
    const id = await add("gone");
    expect(
      (await temp.app.inject({ method: "DELETE", url: `/api/proxies/${String(id)}` })).statusCode,
    ).toBe(204);
    expect(
      (await temp.app.inject({ method: "DELETE", url: `/api/proxies/${String(id)}` })).statusCode,
    ).toBe(404);
  });

  it("POST /:id/test probes through the proxy and records the outcome", async () => {
    const id = await add("t");
    let res = await temp.app.inject({ method: "POST", url: `/api/proxies/${String(id)}/test` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, latency_ms: expect.any(Number) });
    expect(probeCalls).toEqual([SECRET_URL]);

    probeResult = async () => 407;
    res = await temp.app.inject({ method: "POST", url: `/api/proxies/${String(id)}/test` });
    expect(res.json()).toMatchObject({ ok: false, error: "http_407" });

    probeResult = async () => {
      throw Object.assign(new Error(`connect to ${SECRET_URL} failed`), {
        cause: { code: "ECONNREFUSED" },
      });
    };
    res = await temp.app.inject({ method: "POST", url: `/api/proxies/${String(id)}/test` });
    expect(res.json()).toMatchObject({ ok: false, error: "ECONNREFUSED" });
    expect(res.body).not.toContain("hunter2");

    probeResult = async () => {
      throw new Error(`weird ${SECRET_URL}`);
    };
    res = await temp.app.inject({ method: "POST", url: `/api/proxies/${String(id)}/test` });
    expect(res.json()).toMatchObject({ ok: false, error: "connect_failed" });
    expect(res.body).not.toContain("hunter2");

    const row = ProxiesListResponseSchema.parse(
      (await temp.app.inject({ method: "GET", url: "/api/proxies" })).json(),
    ).rows[0];
    expect(row?.fail_count).toBe(3);
    expect(row?.skipped_until).toBe(now + PROXY_SKIP_MS);

    probeResult = async () => 204;
    await temp.app.inject({ method: "POST", url: `/api/proxies/${String(id)}/test` });
    expect(
      ProxiesListResponseSchema.parse(
        (await temp.app.inject({ method: "GET", url: "/api/proxies" })).json(),
      ).rows[0],
    ).toMatchObject({ fail_count: 0, skipped_until: null });
    expect(
      (await temp.app.inject({ method: "POST", url: "/api/proxies/999/test" })).statusCode,
    ).toBe(404);
  });
});

describe("failure accounting and selection", () => {
  it("skips a proxy for ten minutes after three consecutive failures", async () => {
    const id = await add("f", "http://f.test");
    expect(markProxyFailure(temp.db, id, now)).toBe(1);
    expect(markProxyFailure(temp.db, id, now)).toBe(2);
    expect(pickProxy(deps(), "pool")?.id).toBe(id);
    expect(markProxyFailure(temp.db, id, now)).toBe(3);
    expect(pickProxy(deps(), "pool")).toBeNull();
    now += PROXY_SKIP_MS;
    expect(pickProxy(deps(), "pool")?.id).toBe(id);
    markProxyOk(temp.db, id, now);
    expect(temp.db.get("SELECT fail_count, skipped_until FROM proxies")).toEqual({
      fail_count: 0,
      skipped_until: null,
    });
    expect(() => markProxyFailure(temp.db, 999, now)).toThrow(/does not exist/);
  });

  it("round-robins the pool, skipping disabled entries", async () => {
    const a = await add("a", "http://a.test");
    const b = await add("b", "http://b.test");
    await add("off", "http://off.test", false);
    const c = await add("c", "http://c.test");
    const picks = [1, 2, 3, 4].map(() => pickProxy(deps(), "pool")?.id);
    expect(picks).toEqual([a, b, c, a]);
    expect(pickProxy(deps(), "pool")?.url).toBe("http://b.test/");
  });

  it("round-robins an explicit list independently of the pool cursor", async () => {
    const a = await add("a", "http://a.test");
    const b = await add("b", "http://b.test");
    const c = await add("c", "http://c.test");
    expect(pickProxy(deps(), [c, a])?.id).toBe(a);
    expect(pickProxy(deps(), "pool")?.id).toBe(a);
    expect(pickProxy(deps(), [a, c])?.id).toBe(c);
    expect(pickProxy(deps(), [a, c])?.id).toBe(a);
    expect(pickProxy(deps(), [b])?.id).toBe(b);
    expect(pickProxy(deps(), [999])).toBeNull();
  });

  it("returns null for none, an empty list or an empty pool", async () => {
    expect(pickProxy(deps(), "pool")).toBeNull();
    await add("a", "http://a.test");
    expect(pickProxy(deps(), "none")).toBeNull();
    expect(pickProxy(deps(), [])).toBeNull();
  });
});

describe("defaultProxyProbe", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    // A proxy that refuses every CONNECT: exercises the real undici path offline.
    server = createServer((_req, res) => {
      res.writeHead(403).end();
    });
    server.on("connect", (_req, socket) => {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it("fails through a proxy that refuses the tunnel, without leaking credentials", async () => {
    const id = await add("real", `http://user:hunter2@127.0.0.1:${String(port)}`);
    // deps() carries no probe, so the default undici probe runs.
    const result = await testProxy(deps(), id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^[A-Za-z0-9_]+$/);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("reports socks4 as untestable without counting a failure", async () => {
    const id = await add("s4", "socks4://127.0.0.1:1");
    const result = await testProxy({ ...deps(), proxyProbe: defaultProxyProbe }, id);
    expect(result).toMatchObject({ ok: false, error: "unsupported_scheme" });
    expect(temp.db.get("SELECT fail_count FROM proxies WHERE id = ?", id)).toEqual({
      fail_count: 0,
    });
  });

  it("goes through a socks5 agent too", async () => {
    const id = await add("s5", `socks5://127.0.0.1:${String(port)}`);
    const result = await testProxy({ ...deps(), proxyProbe: defaultProxyProbe }, id);
    expect(result.ok).toBe(false);
  });

  it("reports a timeout as timeout", async () => {
    const id = await add("slow", "http://slow.test");
    const result = await testProxy(
      {
        ...deps(),
        proxyProbe: async (_url, signal) => {
          Object.defineProperty(signal, "aborted", { value: true });
          throw new Error("aborted");
        },
      },
      id,
    );
    expect(result.error).toBe("timeout");
  });
});
