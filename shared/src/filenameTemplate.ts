/**
 * Bulk-download filename templates (spec 3.10). Pure logic, no IO.
 *
 * A template is literal text with `{field}` placeholders. Rendering
 * substitutes every placeholder in one pass (a title containing `{id}` is not
 * re-expanded), then sanitises the whole name so neither the template nor a
 * field value can produce a path, a reserved Windows name or an empty name.
 */

export const FILENAME_FIELDS = [
  "title",
  "channel",
  "upload_date",
  "id",
  "ext",
  "source",
  "resolution",
  "duration",
] as const;

export type FilenameField = (typeof FILENAME_FIELDS)[number];

/** Field values; null, undefined and non-finite numbers render as empty text. */
export type FilenameFields = Partial<Record<FilenameField, string | number | null | undefined>>;

export const DEFAULT_FILENAME_TEMPLATE = "{title} [{id}].{ext}";

/** Maximum UTF-8 bytes of a name before its extension (and its `.`). */
export const FILENAME_MAX_STEM_BYTES = 200;

/** Used when both the rendered name and the id sanitise to nothing. */
const FALLBACK_STEM = "video";

const MAX_EXT_LENGTH = 16;

const FIELD_SET: ReadonlySet<string> = new Set(FILENAME_FIELDS);

function isFilenameField(name: string): name is FilenameField {
  return FIELD_SET.has(name);
}

/**
 * A duration in seconds as filename-safe text: `45s`, `4m05s`, `1h02m03s`.
 * Returns "" for negative or non-finite input. Fractions are floored.
 */
export function formatFilenameDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "";
  }
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  if (h > 0) {
    return `${h}h${pad(m)}m${pad(s)}s`;
  }
  if (m > 0) {
    return `${m}m${pad(s)}s`;
  }
  return `${s}s`;
}

function fieldText(field: FilenameField, value: FilenameFields[FilenameField]): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return "";
    }
    if (field === "duration") {
      return formatFilenameDuration(value);
    }
    if (field === "resolution") {
      return `${Math.floor(value)}p`;
    }
    return String(value);
  }
  // yt-dlp's `upload_date` is YYYYMMDD; the template field is YYYY-MM-DD.
  if (field === "upload_date" && /^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
  }
  return value;
}

/** An extension reduced to ASCII letters and digits, lower-cased, at most 16 chars. */
function sanitiseExt(value: FilenameFields["ext"]): string {
  const text = value === null || value === undefined ? "" : String(value);
  return text
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase()
    .slice(0, MAX_EXT_LENGTH);
}

/** UTF-8 byte length; a lone surrogate counts as its 3-byte replacement. */
function utf8Length(text: string): number {
  let total = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    total += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return total;
}

// Unpaired UTF-16 surrogates (`/u` mode treats a valid pair as one code point).
const LONE_SURROGATE_RE = /\p{Cs}/gu;
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/** Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a grapheme. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) {
    return text;
  }
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let out = "";
  let bytes = 0;
  for (const { segment } of segmenter.segment(text)) {
    const size = utf8Length(segment);
    if (bytes + size > maxBytes) {
      break;
    }
    out += segment;
    bytes += size;
  }
  return out;
}

// Invisible formatting characters: zero-width space U+200B, LRM/RLM U+200E-F,
// bidi embeddings and overrides U+202A-E, word joiner U+2060, bidi isolates
// U+2066-9 and BOM U+FEFF. The overrides can disguise an extension (`gpj.exe`
// shown as `exe.jpg`). ZWNJ/ZWJ (U+200C-D) stay: scripts and emoji need them.
const INVISIBLE_RE = /[\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
// C0 and C1 control characters.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1F\x7F-\x9F]/g;
// Path separators and the characters Windows forbids in names.
const RESERVED_CHARS_RE = /[<>:"/\\|?*]/g;
// Windows device names, reserved with or without an extension.
const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

function trimDotsAndSpaces(text: string): string {
  return text.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
}

/** The character-level part of sanitising: no trimming, no length cap. */
function cleanChars(text: string): string {
  return text
    .replace(LONE_SURROGATE_RE, REPLACEMENT_CHAR)
    .normalize("NFC")
    .replace(INVISIBLE_RE, "")
    .replace(CONTROL_RE, " ")
    .replace(RESERVED_CHARS_RE, "_")
    .replace(/\s+/g, " ");
}

/**
 * Sanitise a name without its extension: drop invisible formatting
 * characters, turn control characters into spaces and path separators /
 * Windows-reserved characters into `_`, collapse whitespace, strip leading and
 * trailing dots and spaces, cap at FILENAME_MAX_STEM_BYTES (whole graphemes),
 * and prefix `_` to a reserved device name (`CON`, `nul.tar`, `COM1`, ...).
 * May return "".
 */
export function sanitiseFilenameStem(stem: string): string {
  let out = trimDotsAndSpaces(cleanChars(stem));
  out = trimDotsAndSpaces(truncateUtf8(out, FILENAME_MAX_STEM_BYTES));
  const device = (out.split(".")[0] ?? "").trimEnd();
  if (RESERVED_NAME_RE.test(device)) {
    out = trimDotsAndSpaces(truncateUtf8(`_${out}`, FILENAME_MAX_STEM_BYTES));
  }
  return out;
}

/**
 * Render a bulk-download filename. Known `{field}` placeholders are replaced
 * (null or missing values render empty); unknown placeholders such as `{foo}`
 * stay literal. Numbers are formatted per field: `duration` as `1h02m03s`,
 * `resolution` as `1080p`; a YYYYMMDD `upload_date` becomes YYYY-MM-DD.
 *
 * The extension is the sanitised `ext` field. When the rendered name already
 * ends in `.<ext>` that suffix is the extension; otherwise `.<ext>` is
 * appended, so a template without `{ext}` still yields a playable file. The
 * part before the extension is sanitised (see sanitiseFilenameStem) and is
 * never empty: it falls back to the sanitised id, then to `video`.
 *
 * Over FILENAME_MAX_STEM_BYTES, the title is shortened first so the rest of
 * the template (typically ` [{id}]`) survives; only if that is not enough is
 * the end of the whole name cut.
 */
export function renderFilename(template: string, fields: FilenameFields): string {
  const ext = sanitiseExt(fields.ext);
  const suffix = ext === "" ? "" : `.${ext}`;
  const renderStem = (title: string): string => {
    const rendered = template.replace(/\{([A-Za-z_]+)\}/g, (placeholder, name: string) => {
      if (!isFilenameField(name)) {
        return placeholder;
      }
      if (name === "title") {
        return title;
      }
      return name === "ext" ? ext : fieldText(name, fields[name]);
    });
    return suffix !== "" && rendered.endsWith(suffix)
      ? rendered.slice(0, -suffix.length)
      : rendered;
  };

  // Whitespace collapsing across the title boundary can make one pass come up
  // a byte or two short, so repeat while the title still shrinks.
  let title = fieldText("title", fields.title);
  for (;;) {
    const stemBytes = utf8Length(trimDotsAndSpaces(cleanChars(renderStem(title))));
    const excess = stemBytes - FILENAME_MAX_STEM_BYTES;
    const cleanTitle = cleanChars(title);
    const titleBytes = utf8Length(cleanTitle);
    if (excess <= 0 || titleBytes === 0 || !template.includes("{title}")) {
      break;
    }
    title = truncateUtf8(cleanTitle, Math.max(0, titleBytes - excess));
    if (utf8Length(title) >= titleBytes) {
      break;
    }
  }
  let stem = sanitiseFilenameStem(renderStem(title));
  if (stem === "") {
    stem = sanitiseFilenameStem(fieldText("id", fields.id));
  }
  if (stem === "") {
    stem = FALLBACK_STEM;
  }
  return stem + suffix;
}

/** The key `uniquify` stores in its `taken` set: NFC, lower-cased. */
export function filenameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * Return `name`, or `name (2)`, `name (3)`, ... (the counter goes before the
 * extension) so that it is not already in `taken`, and add the result to
 * `taken`. Comparison is case-insensitive, because ZIP extraction and
 * download folders on Windows and macOS are: `taken` holds filenameKey()
 * values, so seed it with filenameKey(existing) for names uniquify did not
 * produce. The numbered stem is cut so it stays within
 * FILENAME_MAX_STEM_BYTES.
 */
export function uniquify(name: string, taken: Set<string>): string {
  if (!taken.has(filenameKey(name))) {
    taken.add(filenameKey(name));
    return name;
  }
  const match = /^(.+)\.([A-Za-z0-9]{1,16})$/.exec(name);
  const stem = match?.[1] ?? name;
  const suffix = match?.[2] === undefined ? "" : `.${match[2]}`;

  for (let n = 2; ; n++) {
    const counter = `(${n})`;
    const base = trimDotsAndSpaces(
      truncateUtf8(stem, FILENAME_MAX_STEM_BYTES - utf8Length(counter) - 1),
    );
    const candidate = `${base === "" ? "" : `${base} `}${counter}${suffix}`;
    const key = filenameKey(candidate);
    if (!taken.has(key)) {
      taken.add(key);
      return candidate;
    }
  }
}
