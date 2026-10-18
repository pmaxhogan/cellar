import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";
import {
  DARK_MODE_SELECTOR,
  cellarDark,
  cellarFieldBorder,
  cellarPalette,
  cellarPreset,
  cellarSemantic,
  cellarSurface,
} from "../src/theme/cellar-preset.ts";
import { blend, contrastRatio, parseHex, relativeLuminance } from "./helpers/contrast.ts";

/**
 * `@primeuix/themes` 2.x types `Preset["semantic"]` as an open object, so the
 * merged preset has to be viewed structurally before these assertions can read
 * into it. Only the branches asserted below are declared.
 */
type SchemeView = {
  primary?: { color?: string; contrastColor?: string };
  formField?: { borderColor?: string };
};
type SemanticView = {
  primary?: Record<string, string>;
  colorScheme?: Record<string, SchemeView>;
};
const semantic = cellarPreset.semantic as SemanticView | undefined;

type ButtonView = {
  button?: {
    colorScheme?: {
      dark?: { root?: { primary?: Record<string, string> } };
    };
  };
};
const darkButton = (cellarPreset.components as ButtonView | undefined)?.button?.colorScheme?.dark
  ?.root?.primary;

const AA = 4.5;
const NON_TEXT = 3;

describe("contrast helper", () => {
  it("reproduces the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
  });

  it("is symmetric and composites translucent fills", () => {
    expect(contrastRatio("#8e2643", "#ffffff")).toBe(contrastRatio("#ffffff", "#8e2643"));
    expect(blend("#ffffff", 0.5, "#000000")).toBe("#808080");
    expect(blend("#c4405f", 0, "#1f181c")).toBe("#1f181c");
  });

  it("rejects anything that is not #rrggbb", () => {
    expect(() => parseHex("#fff")).toThrow();
    expect(() => parseHex("rgb(0,0,0)")).toThrow();
  });
});

describe("cellar palette", () => {
  it("is a full 50..950 wine ramp of #rrggbb values, darkening monotonically", () => {
    expect(Object.keys(cellarPalette)).toEqual([
      "50",
      "100",
      "200",
      "300",
      "400",
      "500",
      "600",
      "700",
      "800",
      "900",
      "950",
    ]);
    const values = Object.values(cellarPalette);
    for (const value of values) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    for (let i = 1; i < values.length; i += 1) {
      expect(relativeLuminance(values[i]!)).toBeLessThan(relativeLuminance(values[i - 1]!));
    }
  });

  it("has a 12-step surface ramp and four semantic colors per scheme", () => {
    expect(Object.keys(cellarSurface)).toHaveLength(12);
    for (const value of Object.values(cellarSurface)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    for (const scheme of [cellarSemantic.light, cellarSemantic.dark]) {
      for (const key of ["success", "warn", "error", "info"] as const) {
        expect(scheme[key]).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});

describe("measured contrast (docs/brand/palette.md)", () => {
  const darkPage = cellarSurface[950];
  const darkCard = cellarSurface[900];
  const lightPage = cellarSurface[50];
  const lightCard = cellarSurface[0];

  it("keeps dark-mode text readable on page, card and elevated surfaces", () => {
    for (const bg of [darkPage, darkCard, cellarDark.elevated]) {
      expect(contrastRatio(cellarDark.text, bg)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(cellarDark.textMuted, bg)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(cellarDark.textSubtle, bg)).toBeGreaterThanOrEqual(AA);
      expect(contrastRatio(cellarPalette[400], bg)).toBeGreaterThanOrEqual(AA);
    }
  });

  it("keeps light-mode text readable on page, card and hover surfaces", () => {
    for (const bg of [lightPage, lightCard, cellarSurface[100]]) {
      expect(contrastRatio(cellarSurface[900], bg)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(cellarSurface[700], bg)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(cellarSurface[600], bg)).toBeGreaterThanOrEqual(AA);
      expect(contrastRatio(cellarPalette[700], bg)).toBeGreaterThanOrEqual(7);
    }
  });

  it("puts white on every dark-mode Button state, and it passes AA", () => {
    expect(darkButton?.background).toBe("{primary.500}");
    expect(darkButton?.hoverBackground).toBe("{primary.600}");
    expect(darkButton?.activeBackground).toBe("{primary.700}");
    expect(darkButton?.color).toBe("#ffffff");
    expect(contrastRatio("#ffffff", cellarPalette[500])).toBeCloseTo(4.95, 2);
    for (const step of [500, 600, 700] as const) {
      expect(contrastRatio("#ffffff", cellarPalette[step])).toBeGreaterThanOrEqual(AA);
    }
  });

  it("puts white on every light-mode primary fill, and it passes AA", () => {
    for (const step of [700, 800, 900] as const) {
      expect(contrastRatio("#ffffff", cellarPalette[step])).toBeGreaterThanOrEqual(7);
    }
  });

  it("never puts white on primary-400, the dark-mode small fill", () => {
    // White on 400 is 2.97:1. If someone "fixes" contrastColor to #ffffff every
    // filled primary control in dark mode silently fails AA.
    expect(contrastRatio("#ffffff", cellarPalette[400])).toBeLessThan(AA);
    expect(semantic?.colorScheme?.dark?.primary?.contrastColor).toBe(cellarDark.onPrimary);
    for (const step of [200, 300, 400] as const) {
      expect(contrastRatio(cellarDark.onPrimary, cellarPalette[step])).toBeGreaterThanOrEqual(AA);
    }
  });

  it("keeps the focus ring, the Button fill and field outlines at 3:1 or better", () => {
    expect(contrastRatio(cellarPalette[400], darkPage)).toBeGreaterThanOrEqual(NON_TEXT);
    expect(contrastRatio(cellarPalette[700], lightPage)).toBeGreaterThanOrEqual(NON_TEXT);
    expect(contrastRatio(cellarPalette[500], darkCard)).toBeGreaterThanOrEqual(NON_TEXT);
    for (const bg of [darkCard, cellarDark.elevated]) {
      expect(contrastRatio(cellarFieldBorder.dark, bg)).toBeGreaterThanOrEqual(NON_TEXT);
    }
    for (const bg of [lightCard, lightPage]) {
      expect(contrastRatio(cellarFieldBorder.light, bg)).toBeGreaterThanOrEqual(NON_TEXT);
    }
    expect(semantic?.colorScheme?.dark?.formField?.borderColor).toBe(cellarFieldBorder.dark);
    expect(semantic?.colorScheme?.light?.formField?.borderColor).toBe(cellarFieldBorder.light);
  });

  it("keeps the active nav item readable on its translucent wine wash", () => {
    const wash = blend("#c4405f", 0.16, darkCard);
    expect(contrastRatio(cellarPalette[300], wash)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(cellarPalette[700], cellarPalette[50])).toBeGreaterThanOrEqual(7);
  });

  it("keeps semantic colors at AA on both page backgrounds", () => {
    for (const key of ["success", "warn", "error", "info"] as const) {
      expect(contrastRatio(cellarSemantic.light[key], lightPage)).toBeGreaterThanOrEqual(AA);
      expect(contrastRatio(cellarSemantic.dark[key], darkPage)).toBeGreaterThanOrEqual(AA);
    }
  });

  it("keeps main.css in step with the preset's semantic colors", () => {
    // Read from disk: vitest stubs CSS imports, ?raw included, to an empty string.
    const mainCss = readFileSync(join(import.meta.dirname, "../src/assets/main.css"), "utf8");
    for (const scheme of [cellarSemantic.light, cellarSemantic.dark]) {
      for (const key of ["success", "warn", "error", "info"] as const) {
        expect(mainCss).toContain(scheme[key]);
      }
    }
  });
});

describe("cellar preset", () => {
  it("matches the dark mode class index.html puts on the document element", () => {
    expect(DARK_MODE_SELECTOR).toBe(".cellar-dark");
    expect(indexHtml).toContain('class="cellar-dark"');
  });

  it("uses the wine ramp as primary, 400 in dark and 700 in light", () => {
    expect(semantic?.primary).toMatchObject(cellarPalette);
    expect(semantic?.colorScheme?.dark?.primary?.color).toBe("{primary.400}");
    expect(semantic?.colorScheme?.light?.primary?.color).toBe("{primary.700}");
    expect(semantic?.colorScheme?.light?.primary?.contrastColor).toBe("#ffffff");
  });

  it("never reaches for an Aura stock primitive that looks like wine", () => {
    // "{rose.600}" resolves to Aura's built-in Tailwind rose, NOT the palette
    // above: a preset that looks almost right with none of the measured
    // contrast holding. Aura's own references (slate, zinc, and friends) remain
    // in the merged semantic, so this bans the lookalike namespaces only.
    const namespaces = new Set<string>();
    const walk = (node: unknown): void => {
      if (typeof node === "string") {
        for (const match of node.matchAll(/\{([a-z]+)\.[a-zA-Z0-9.]+\}/g)) {
          namespaces.add(match[1] as string);
        }
        return;
      }
      if (node !== null && typeof node === "object") {
        for (const value of Object.values(node)) walk(value);
      }
    };
    walk(cellarPreset.semantic);
    walk(cellarPreset.components);
    for (const banned of ["rose", "pink", "fuchsia"]) {
      expect(namespaces.has(banned)).toBe(false);
    }
    expect(namespaces.has("primary")).toBe(true);
  });
});
