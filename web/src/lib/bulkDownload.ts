import {
  DEFAULT_FILENAME_TEMPLATE,
  FILENAME_FIELDS,
  renderFilename,
  type BulkKind,
  type FilenameField,
  type FilenameFields,
  type VideoRow,
} from "@cellar/shared";

/**
 * Bulk download helpers that need no network: the live filename preview and
 * the hidden form post that hands the ZIP stream to the browser's download
 * manager.
 */

export const BULK_DOWNLOAD_ACTION = "/api/videos/bulk-download";

/** The hidden iframe the ZIP form posts into, so an error body never replaces the app. */
export const BULK_DOWNLOAD_FRAME = "cellar-bulk-download";

/** Longest template the server accepts. */
export const MAX_TEMPLATE_LENGTH = 500;

export const BULK_KIND_OPTIONS: { label: string; value: BulkKind; hint: string }[] = [
  { label: "Video", value: "video", hint: "The current video file of each selected video." },
  { label: "Audio", value: "audio", hint: "The current audio-only file, where one exists." },
  { label: "Captions", value: "captions", hint: "Every stored caption track as WebVTT." },
  {
    label: "Everything",
    value: "all",
    hint: "Video, audio, captions and the metadata JSON of each video.",
  },
];

/** What each template field stands for, shown next to the template input. */
export const FIELD_HINTS: Record<FilenameField, string> = {
  title: "video title",
  channel: "channel title",
  upload_date: "YYYY-MM-DD",
  id: "11-character video id",
  ext: "file extension",
  source: "first source it came from",
  resolution: "for example 1080p",
  duration: "for example 4m05s",
};

export const TEMPLATE_FIELDS: readonly FilenameField[] = FILENAME_FIELDS;

/** Null when the template is usable, else why not. */
export function templateProblem(template: string): string | null {
  const text = template.trim();
  if (text === "") return "Enter a template, for example {title} [{id}].{ext}";
  if (text.length > MAX_TEMPLATE_LENGTH) {
    return `Templates are limited to ${MAX_TEMPLATE_LENGTH} characters.`;
  }
  return null;
}

/** The template the server is sent: the default stands in for a blank one. */
export function effectiveTemplate(template: string): string {
  const text = template.trim();
  return text === "" ? DEFAULT_FILENAME_TEMPLATE : text;
}

function isoDay(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString().slice(0, 10);
}

/** The source a video was first seen through, as the server names files with it. */
export function firstSource(row: Pick<VideoRow, "sources">): string | null {
  let best: VideoRow["sources"][number] | null = null;
  for (const source of row.sources) {
    if (best === null || source.first_seen_at < best.first_seen_at) best = source;
  }
  return best?.source ?? null;
}

/** Template fields for a row, mirroring the server's videoFilenameFields. */
export function rowFilenameFields(row: VideoRow): FilenameFields {
  return {
    title: row.title,
    channel: row.channel_title,
    upload_date: isoDay(row.upload_date),
    id: row.id,
    source: firstSource(row),
    duration: row.duration_s,
  };
}

/**
 * A preview of the names one video would get. The real extension comes from
 * the stored file, which the list row does not carry, so the preview assumes
 * the usual container for the kind.
 */
export function previewNames(template: string, row: VideoRow, kind: BulkKind): string[] {
  const fields = rowFilenameFields(row);
  const tpl = effectiveTemplate(template);
  const video = renderFilename(tpl, { ...fields, ext: "mp4", resolution: row.max_height });
  const audio = renderFilename(tpl, { ...fields, ext: "m4a" });
  const stem = video.replace(/\.mp4$/, "");
  const captions = `${stem}.en.vtt`;
  switch (kind) {
    case "video":
      return [video];
    case "audio":
      return [audio];
    case "captions":
      return [captions];
    case "all":
      return [video, audio, captions, `${stem}.metadata.json`];
  }
}

export interface ZipRequest {
  ids: readonly string[];
  kind: BulkKind;
  template: string;
}

/** The hidden iframe a ZIP post targets, created once per document. */
export function ensureDownloadFrame(doc: Document = document): HTMLIFrameElement {
  const existing = doc.querySelector<HTMLIFrameElement>(`iframe[name='${BULK_DOWNLOAD_FRAME}']`);
  if (existing !== null) return existing;
  const frame = doc.createElement("iframe");
  frame.name = BULK_DOWNLOAD_FRAME;
  frame.title = "Bulk download";
  frame.hidden = true;
  frame.tabIndex = -1;
  doc.body.appendChild(frame);
  return frame;
}

/** Build (but do not submit) the form. Exported so a test can read its fields. */
export function buildZipForm(request: ZipRequest, doc: Document = document): HTMLFormElement {
  const form = doc.createElement("form");
  form.method = "POST";
  form.action = BULK_DOWNLOAD_ACTION;
  form.target = BULK_DOWNLOAD_FRAME;
  form.enctype = "application/x-www-form-urlencoded";
  form.hidden = true;
  const add = (name: string, value: string): void => {
    const input = doc.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  };
  // One comma-joined field: the server splits it, and 10,000 ids stay far
  // under the form body limit where 10,000 inputs would bloat the DOM.
  add("ids", request.ids.join(","));
  add("kind", request.kind);
  const template = request.template.trim();
  if (template !== "") add("template", template);
  return form;
}

/**
 * Post the selection as a plain HTML form. The response is an attachment, so
 * the browser streams it straight to disk with its own progress UI instead of
 * buffering gigabytes in a fetch.
 */
export function submitZipDownload(request: ZipRequest, doc: Document = document): void {
  ensureDownloadFrame(doc);
  const form = buildZipForm(request, doc);
  doc.body.appendChild(form);
  try {
    form.submit();
  } finally {
    form.remove();
  }
}
