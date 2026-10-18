import { describe, expect, it } from "vitest";
import {
  boundedTest,
  checkRegexSafety,
  compileSafeRegex,
  isSafeRegex,
  MAX_REGEX_INPUT,
  MAX_REGEX_LENGTH,
} from "../../src/index.ts";

describe("checkRegexSafety", () => {
  it.each([
    "^foo",
    "colou?r",
    "(cat|dog)s?",
    "(cat|dog)+",
    "\\d{4}-\\d{2}-\\d{2}",
    "[a-z]+\\s(review|unboxing)",
    "(?:ab){3}",
    "a{2,5}",
    "[(+*]",
    "\\(x+\\)",
    "^$",
    "(?<year>\\d{4})",
  ])("accepts %s", (pattern) => {
    expect(checkRegexSafety(pattern)).toBeNull();
    expect(isSafeRegex(pattern)).toBe(true);
  });

  it.each([
    ["(a+)+", "nested_quantifier"],
    ["(a*)*", "nested_quantifier"],
    ["^(a+)+$", "nested_quantifier"],
    ["(\\w+\\s?)+", "nested_quantifier"],
    ["(x+x+)+y", "nested_quantifier"],
    ["(.*a){20}", "nested_quantifier"],
    ["((a+))+", "nested_quantifier"],
    ["(a?){25}", "nested_quantifier"],
    ["(?:a+)+b", "nested_quantifier"],
    ["(a|a)*", "ambiguous_alternation"],
    ["(a|ab)*", "ambiguous_alternation"],
    ["(.|\\s)+", "ambiguous_alternation"],
    ["((a|ab))+", "ambiguous_alternation"],
    ["(a)\\1", "backreference"],
    ["(?<x>a)\\k<x>", "backreference"],
    ["a*b*c*d*", "too_many_quantifiers"],
    [".*.*.*.*x", "too_many_quantifiers"],
    ["(", "invalid"],
    ["[z-a]", "invalid"],
    ["a".repeat(MAX_REGEX_LENGTH + 1), "too_long"],
  ])("rejects %s as %s", (pattern, code) => {
    expect(checkRegexSafety(pattern)?.code).toBe(code);
    expect(isSafeRegex(pattern)).toBe(false);
  });

  it("accepts a pattern exactly at the length limit", () => {
    expect(checkRegexSafety("a".repeat(MAX_REGEX_LENGTH))).toBeNull();
  });
});

describe("compileSafeRegex", () => {
  it("compiles safe patterns, honouring the case flag", () => {
    const cs = compileSafeRegex("^Hello");
    const ci = compileSafeRegex("^hello", true);
    expect(cs?.test("Hello there")).toBe(true);
    expect(cs?.test("hello there")).toBe(false);
    expect(ci?.test("HELLO there")).toBe(true);
  });

  it("returns null for unsafe patterns, repeatedly (memoised)", () => {
    expect(compileSafeRegex("(a+)+")).toBeNull();
    expect(compileSafeRegex("(a+)+")).toBeNull();
  });

  it("returns the same compiled object for the same pattern and flag", () => {
    expect(compileSafeRegex("abc")).toBe(compileSafeRegex("abc"));
    expect(compileSafeRegex("abc")).not.toBe(compileSafeRegex("abc", true));
  });

  it("keeps working past the cache limit", () => {
    for (let i = 0; i < 600; i++) expect(compileSafeRegex(`x${i}y`)).not.toBeNull();
    expect(compileSafeRegex("x5y")?.test("x5y")).toBe(true);
  });
});

describe("boundedTest", () => {
  it("only searches the first MAX_REGEX_INPUT characters", () => {
    const re = compileSafeRegex("needle")!;
    const early = "needle" + "x".repeat(MAX_REGEX_INPUT * 2);
    const late = "x".repeat(MAX_REGEX_INPUT) + "needle";
    expect(boundedTest(re, early)).toBe(true);
    expect(boundedTest(re, late)).toBe(false);
  });

  it("finishes quickly on adversarial input for an accepted pattern", () => {
    const re = compileSafeRegex("^(\\w|\\s)+x$");
    // Rejected statically: overlapping alternation inside a repeat.
    expect(re).toBeNull();
    const ok = compileSafeRegex("^[a ]+x$")!;
    const started = Date.now();
    expect(boundedTest(ok, "a ".repeat(50_000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
