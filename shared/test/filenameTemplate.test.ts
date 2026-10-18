import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILENAME_TEMPLATE,
  FILENAME_MAX_STEM_BYTES,
  filenameKey,
  formatFilenameDuration,
  renderFilename,
  sanitiseFilenameStem,
  uniquify,
  type FilenameFields,
} from "../src/filenameTemplate.ts";

const ID = "dQw4w9WgXcQ";
const RICK: FilenameFields = {
  title: "Never Gonna Give You Up",
  channel: "Rick Astley",
  upload_date: "2009-10-25",
  id: ID,
  ext: "mp4",
  source: "liked",
  resolution: "1080p",
  duration: 213,
};

const cp = (...points: number[]): string => String.fromCodePoint(...points);
const bytes = (text: string): number => new TextEncoder().encode(text).length;

function render(title: string | null, template = DEFAULT_FILENAME_TEMPLATE): string {
  return renderFilename(template, { ...RICK, title });
}

describe("formatFilenameDuration", () => {
  const cases: [number, string][] = [
    [0, "0s"],
    [45, "45s"],
    [59.9, "59s"],
    [60, "1m00s"],
    [245, "4m05s"],
    [3600, "1h00m00s"],
    [3723, "1h02m03s"],
    [90061, "25h01m01s"],
    [-1, ""],
    [Number.NaN, ""],
    [Number.POSITIVE_INFINITY, ""],
  ];
  it.each(cases)("%s -> %s", (seconds, expected) => {
    expect(formatFilenameDuration(seconds)).toBe(expected);
  });
});

describe("renderFilename fields and placeholders", () => {
  it("renders the default template", () => {
    expect(DEFAULT_FILENAME_TEMPLATE).toBe("{title} [{id}].{ext}");
    expect(renderFilename(DEFAULT_FILENAME_TEMPLATE, RICK)).toBe(
      `Never Gonna Give You Up [${ID}].mp4`,
    );
  });

  it("renders every field and formats numbers per field", () => {
    const template =
      "{upload_date} {channel} - {title} ({resolution}, {duration}) [{source}] {id}.{ext}";
    const fields = { ...RICK, upload_date: "20091025", resolution: 1080, duration: 213 };
    expect(renderFilename(template, fields)).toBe(
      `2009-10-25 Rick Astley - Never Gonna Give You Up (1080p, 3m33s) [liked] ${ID}.mp4`,
    );
  });

  it("leaves unknown and wrongly-cased placeholders literal", () => {
    expect(renderFilename("{title} {foo} {Title} {} {id.{ext}", RICK)).toBe(
      "Never Gonna Give You Up {foo} {Title} {} {id.mp4",
    );
  });

  it("does not re-expand placeholders found in field values", () => {
    expect(render("about {id} and {ext}")).toBe(`about {id} and {ext} [${ID}].mp4`);
  });

  it("renders null, undefined and non-finite values as empty text", () => {
    const fields: FilenameFields = { ...RICK, channel: null, source: undefined, duration: NaN };
    expect(renderFilename("{title} [{channel}] [{source}] [{duration}].{ext}", fields)).toBe(
      "Never Gonna Give You Up [] [] [].mp4",
    );
  });

  it("appends the extension when the template has no {ext}", () => {
    expect(render("Title", "{title}")).toBe("Title.mp4");
    expect(render("Title", "{title} mp4")).toBe("Title mp4.mp4");
  });

  it("sanitises the extension", () => {
    expect(renderFilename("{title}.{ext}", { title: "T", ext: ".MP4" })).toBe("T.mp4");
    expect(renderFilename("{title}.{ext}", { title: "T", ext: "../e x/e" })).toBe("T.exe");
  });

  it("returns a bare name when there is no extension", () => {
    expect(renderFilename("{title}.{ext}", { title: "T", id: ID })).toBe("T");
    expect(renderFilename("{title}", {})).toBe("video");
  });
});

describe("renderFilename sanitisation", () => {
  const cases: [string, string | null, string, string][] = [
    ["path separators", "AC/DC: Back\\In Black", "{title}.{ext}", "AC_DC_ Back_In Black.mp4"],
    ["separators in the template", "Song", "{channel}/{title}\\x.{ext}", "Rick Astley_Song_x.mp4"],
    ["traversal", "../../etc/passwd", "{title}.{ext}", "_.._etc_passwd.mp4"],
    ["Windows-reserved characters", 'a<b>c:d"e|f?g*h', "{title}.{ext}", "a_b_c_d_e_f_g_h.mp4"],
    ["control characters", "a\tb\nc\u0000d\u007fe\u009ff", "{title}.{ext}", "a b c d e f.mp4"],
    ["collapsed whitespace", "  a    b \r\n c  ", "{title}.{ext}", "a b c.mp4"],
    ["trailing dots and spaces", "Hello... . ", "{title}.{ext}", "Hello.mp4"],
    ["leading dots", ".hidden", "{title}.{ext}", "hidden.mp4"],
    ["dot-only title falls back to the id", "..", "{title}.{ext}", `${ID}.mp4`],
    ["empty title falls back to the id", "", "{title}.{ext}", `${ID}.mp4`],
    ["null title keeps the template", null, "{title} [{id}].{ext}", `[${ID}].mp4`],
    ["reserved device name", "CON", "{title}.{ext}", "_CON.mp4"],
    ["reserved name before a dot", "nul.tar", "{title}.{ext}", "_nul.tar.mp4"],
    ["reserved name, trailing space", "com1 .x", "{title}.{ext}", "_com1 .x.mp4"],
    ["reserved name, any case", "Lpt9", "{title}.{ext}", "_Lpt9.mp4"],
    ["not reserved: longer word", "CONSOLE", "{title}.{ext}", "CONSOLE.mp4"],
    ["not reserved: com10", "com10", "{title}.{ext}", "com10.mp4"],
  ];
  it.each(cases)("%s", (_name, title, template, expected) => {
    expect(render(title, template)).toBe(expected);
  });

  it("strips bidi overrides and zero-width spaces but keeps ZWJ sequences", () => {
    const rlo = cp(0x202e);
    const zwsp = cp(0x200b);
    expect(render(`abc${rlo}4pm.exe${zwsp}`, "{title}.{ext}")).toBe("abc4pm.exe.mp4");
    const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    expect(render(`Family ${family}`, "{title}.{ext}")).toBe(`Family ${family}.mp4`);
  });

  it("keeps non-ASCII titles, NFC-normalised", () => {
    const decomposed = "Cafe" + cp(0x301);
    const composed = "Caf" + cp(0xe9);
    const kanji = cp(0x65e5, 0x672c);
    expect(render(`${decomposed} ${kanji}`, "{title}.{ext}")).toBe(`${composed} ${kanji}.mp4`);
  });

  it("replaces lone surrogates instead of emitting invalid UTF-16", () => {
    const name = render(`a${String.fromCharCode(0xd800)}b`, "{title}.{ext}");
    expect(name).toBe(`a${cp(0xfffd)}b.mp4`);
  });

  it("treats non-breaking spaces as whitespace", () => {
    expect(render(`a${cp(0xa0, 0xa0)}b`, "{title}.{ext}")).toBe("a b.mp4");
  });
});

describe("renderFilename length cap", () => {
  const stemOf = (name: string): string => name.replace(/\.mp4$/, "");

  it("shortens the title so the id survives", () => {
    const name = render("a".repeat(300));
    expect(name).toBe(`${"a".repeat(FILENAME_MAX_STEM_BYTES - 14)} [${ID}].mp4`);
    expect(bytes(stemOf(name))).toBe(FILENAME_MAX_STEM_BYTES);
  });

  it("is exact even when whitespace collapses across the title boundary", () => {
    const name = render(`${"a".repeat(300)} `);
    expect(name.endsWith(` [${ID}].mp4`)).toBe(true);
    expect(bytes(stemOf(name))).toBeLessThanOrEqual(FILENAME_MAX_STEM_BYTES);
  });

  it("counts UTF-8 bytes, not characters", () => {
    const eAcute = cp(0xe9);
    const name = render(eAcute.repeat(150), "{title}.{ext}");
    expect(name).toBe(`${eAcute.repeat(100)}.mp4`);
  });

  it("never splits a grapheme cluster", () => {
    const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467); // 18 bytes
    const name = render(family.repeat(20), "{title}.{ext}");
    expect(name).toBe(`${family.repeat(11)}.mp4`);
  });

  it("re-strips dots and spaces exposed by the cut", () => {
    const name = render(`${"a".repeat(198)} .xyz`, "{title}.{ext}");
    expect(name).toBe(`${"a".repeat(198)}.mp4`);
  });

  it("cuts the whole name when the template alone is too long", () => {
    const name = renderFilename(`${"x".repeat(250)} {id}.{ext}`, RICK);
    expect(name).toBe(`${"x".repeat(FILENAME_MAX_STEM_BYTES)}.mp4`);
  });
});

describe("sanitiseFilenameStem", () => {
  it("may return an empty string", () => {
    expect(sanitiseFilenameStem(" . . ")).toBe("");
  });
  it("prefixes a reserved name revealed by trimming", () => {
    expect(sanitiseFilenameStem("  aux. ")).toBe("_aux");
  });
});

describe("uniquify", () => {
  it("returns the name unchanged the first time and records it", () => {
    const taken = new Set<string>();
    expect(uniquify("A.mp4", taken)).toBe("A.mp4");
    expect(taken.has(filenameKey("A.mp4"))).toBe(true);
  });

  it("numbers collisions before the extension", () => {
    const taken = new Set<string>();
    expect(uniquify("A.mp4", taken)).toBe("A.mp4");
    expect(uniquify("A.mp4", taken)).toBe("A (2).mp4");
    expect(uniquify("A.mp4", taken)).toBe("A (3).mp4");
    expect(uniquify("A (2).mp4", taken)).toBe("A (2) (2).mp4");
  });

  it("compares case-insensitively", () => {
    const taken = new Set<string>();
    uniquify("song.mp4", taken);
    expect(uniquify("SONG.MP4", taken)).toBe("SONG (2).MP4");
  });

  it("can be seeded with filenameKey", () => {
    const taken = new Set([filenameKey("Existing.webm")]);
    expect(uniquify("existing.webm", taken)).toBe("existing (2).webm");
  });

  it("skips numbers that are already taken", () => {
    const taken = new Set(["a.mp4", "a (2).mp4"].map(filenameKey));
    expect(uniquify("a.mp4", taken)).toBe("a (3).mp4");
  });

  it("handles names without an extension", () => {
    const taken = new Set([filenameKey("README"), filenameKey("v1.0 final")]);
    expect(uniquify("README", taken)).toBe("README (2)");
    expect(uniquify("v1.0 final", taken)).toBe("v1.0 final (2)");
  });

  it("keeps a maximum-length stem within the byte cap", () => {
    const name = `${"a".repeat(FILENAME_MAX_STEM_BYTES)}.mp4`;
    const taken = new Set<string>();
    uniquify(name, taken);
    const second = uniquify(name, taken);
    expect(second).toBe(`${"a".repeat(FILENAME_MAX_STEM_BYTES - 4)} (2).mp4`);
    expect(bytes(second.replace(/\.mp4$/, ""))).toBe(FILENAME_MAX_STEM_BYTES);
  });

  it("works with renderFilename output for a bulk batch", () => {
    const taken = new Set<string>();
    const names = ["Same", "same", "Same"].map((title) =>
      uniquify(renderFilename("{title}.{ext}", { title, ext: "mp4" }), taken),
    );
    expect(names).toEqual(["Same.mp4", "same (2).mp4", "Same (3).mp4"]);
  });
});
