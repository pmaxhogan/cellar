import { cellarDark, cellarPalette, cellarSurface } from "../../theme/cellar-preset.ts";

/**
 * Chart colors, per color scheme. A canvas cannot resolve CSS custom
 * properties, so the chart reads the same preset constants the PrimeVue theme
 * is built from (theme/cellar-preset.ts) and picks the scheme from the theme
 * store; a toggle rebuilds the chart config.
 *
 * Roles:
 *  - single-measure charts (downloads, catalog, gone, API units) draw in the
 *    accent, `primary.color` of the scheme (primary-400 dark, primary-700 light);
 *  - one series per location uses the categorical slots below, assigned in a
 *    fixed order by location id so a filter never repaints a location;
 *  - text, ticks and legends wear text tokens, never a series color.
 *
 * The categorical steps are the dataviz reference palette, re-validated against
 * cellar's card surfaces (#ffffff light, #1f181c dark) with the skill's
 * validator: every check passes in both modes on the adjacent pairlist. In light
 * mode slots 3-5 sit below 3:1 against white, which is why every chart has a
 * data table view.
 */

const CATEGORICAL_LIGHT = [
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
  "#6250d6",
  "#e34948",
] as const;

const CATEGORICAL_DARK = [
  "#3987e5",
  "#d95926",
  "#199e70",
  "#c98500",
  "#d55181",
  "#008300",
  "#9085e9",
  "#e66767",
] as const;

/** Series slots. A ninth location folds into the last slot as "Other". */
export const SERIES_SLOTS = CATEGORICAL_LIGHT.length;

export interface ChartTheme {
  dark: boolean;
  /** The single-measure mark color. */
  accent: string;
  /** The accent as a ~10% wash for area fills. */
  accentWash: string;
  text: string;
  muted: string;
  /** Hairline gridlines. */
  grid: string;
  /** The baseline and axis line. */
  axis: string;
  /** The card the chart sits on (bar gaps, point rings, tooltip). */
  surface: string;
  tooltip: string;
  /** Reference lines such as the API budget. */
  reference: string;
  series: readonly string[];
}

export function chartTheme(dark: boolean): ChartTheme {
  if (dark) {
    return {
      dark,
      accent: cellarPalette[400],
      accentWash: withAlpha(cellarPalette[400], 0.1),
      text: cellarDark.text,
      muted: cellarDark.textMuted,
      grid: cellarDark.border,
      axis: cellarSurface[700],
      surface: cellarSurface[900],
      tooltip: cellarDark.elevated,
      reference: cellarDark.textMuted,
      series: CATEGORICAL_DARK,
    };
  }
  return {
    dark,
    accent: cellarPalette[700],
    accentWash: withAlpha(cellarPalette[700], 0.1),
    text: cellarSurface[900],
    muted: cellarSurface[700],
    grid: cellarSurface[200],
    axis: cellarSurface[300],
    surface: cellarSurface[0],
    tooltip: cellarSurface[0],
    reference: cellarSurface[600],
    series: CATEGORICAL_LIGHT,
  };
}

/** `#rrggbb` plus an alpha channel. */
export function withAlpha(hex: string, alpha: number): string {
  const byte = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return `${hex}${byte.toString(16).padStart(2, "0")}`;
}

/** The slot of the series at `index`; indexes past the last slot share it. */
export function seriesColor(theme: ChartTheme, index: number): string {
  const slot = Math.min(Math.max(0, index), SERIES_SLOTS - 1);
  return theme.series[slot] ?? theme.accent;
}
