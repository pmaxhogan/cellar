import { describe, expect, it } from "vitest";
import { CELLAR_VERSION } from "../src/index.ts";

describe("version", () => {
  it("is a semver string", () => {
    expect(CELLAR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
