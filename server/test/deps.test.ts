import { describe, expect, it } from "vitest";
import { fetchOf, nowOf, requireSecretKey } from "../src/domain/deps.ts";

describe("service deps defaults", () => {
  it("falls back to the global fetch and Date.now", async () => {
    const response = await fetchOf({})("data:text/plain,hi");
    expect(await response.text()).toBe("hi");
    const before = Date.now();
    expect(nowOf({})).toBeGreaterThanOrEqual(before);
    expect(nowOf({ now: () => 5 })).toBe(5);
  });

  it("requireSecretKey answers 412 without the key and returns a usable one", () => {
    expect(() => requireSecretKey({ secretKey: null })).toThrow(/CELLAR_SECRET_KEY/);
    const key = Buffer.alloc(32, 1);
    expect(requireSecretKey({ secretKey: key })).toBe(key);
  });
});
