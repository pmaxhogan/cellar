/**
 * WCAG 2.x contrast, measured rather than eyeballed. Used by palette.test.ts and
 * by the one-off run that produced the tables in docs/brand/palette.md.
 */

type Rgb = readonly [number, number, number];

/** "#rrggbb" to 0..255 channels. */
export function parseHex(hex: string): Rgb {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) throw new Error(`Not a #rrggbb color: ${hex}`);
  return [parseInt(match[1]!, 16), parseInt(match[2]!, 16), parseInt(match[3]!, 16)];
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

/** An rgba() overlay composited onto an opaque backdrop, as the browser paints it. */
export function blend(overlay: string, alpha: number, backdrop: string): string {
  const top = parseHex(overlay);
  const bottom = parseHex(backdrop);
  return toHex([0, 1, 2].map((i) => top[i]! * alpha + bottom[i]! * (1 - alpha)) as never);
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** (L1 + 0.05) / (L2 + 0.05), lighter over darker. Order of arguments is irrelevant. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
