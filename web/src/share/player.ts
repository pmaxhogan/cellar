import { shareUrls, type ShareCaption, type ShareData } from "./data.ts";
import { formatBytes, formatCount, formatDate, formatDuration } from "./format.ts";

/**
 * The live share view: player (video with caption tracks, or audio), speed
 * menu, keyboard shortcuts, download buttons, description and counters.
 * Built with createElement and textContent only: nothing from the payload is
 * ever parsed as HTML.
 */

export const SPEEDS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export const SEEK_SMALL_S = 5;
export const SEEK_LARGE_S = 10;
export const VOLUME_STEP = 0.1;

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The track shown by default: the first English one, else the first one. */
export function defaultCaption(captions: readonly ShareCaption[]): ShareCaption | null {
  return captions.find((c) => c.lang === "en" || /^en[-_]/i.test(c.lang)) ?? captions[0] ?? null;
}

export function speedLabel(speed: number): string {
  return speed === 1 ? "Normal" : `${speed}x`;
}

function buildSpeedMenu(doc: Document, media: HTMLMediaElement): HTMLElement {
  const wrap = el(doc, "label", "share-speed");
  wrap.append(el(doc, "span", "share-speed__label", "Speed"));
  const select = el(doc, "select", "share-speed__select");
  select.setAttribute("aria-label", "Playback speed");
  select.dataset["test"] = "speed";
  for (const speed of SPEEDS) {
    const option = el(doc, "option", "", speedLabel(speed));
    option.value = String(speed);
    select.append(option);
  }
  select.addEventListener("change", () => {
    const value = Number(select.value);
    if (SPEEDS.includes(value)) media.playbackRate = value;
  });
  // The rate can also change from the browser's own menu; keep the select in step.
  media.addEventListener("ratechange", () => {
    if (SPEEDS.includes(media.playbackRate)) select.value = String(media.playbackRate);
  });
  select.value = "1";
  wrap.append(select);
  return wrap;
}

function clampTime(media: HTMLMediaElement, at: number): number {
  const end = Number.isFinite(media.duration) ? media.duration : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(0, at), end);
}

function togglePlay(media: HTMLMediaElement): void {
  if (media.paused) {
    // play() rejects when autoplay is blocked or the source fails; the native
    // controls show that state, so the rejection is not reported twice.
    void Promise.resolve(media.play()).catch(() => undefined);
  } else {
    media.pause();
  }
}

/** Elements whose own keyboard handling must win over the page shortcuts. */
function ownsKeys(target: EventTarget | null): boolean {
  // A focused player has its own keys.
  if (target instanceof HTMLMediaElement) return true;
  if (!(target instanceof Element)) return false;
  return target.closest("input, select, textarea, button, a, summary, [contenteditable]") !== null;
}

/**
 * space / k: play or pause. j / l: back or forward 10 s. Left / Right: 5 s.
 * Up / Down: volume. Ignored with a modifier, and while a control (or the
 * focused player, which has its own keys) has focus.
 */
export function handleShortcut(event: KeyboardEvent, media: HTMLMediaElement): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (ownsKeys(event.target)) return false;
  switch (event.key) {
    case " ":
    case "k":
    case "K":
      togglePlay(media);
      break;
    case "j":
    case "J":
      media.currentTime = clampTime(media, media.currentTime - SEEK_LARGE_S);
      break;
    case "l":
    case "L":
      media.currentTime = clampTime(media, media.currentTime + SEEK_LARGE_S);
      break;
    case "ArrowLeft":
      media.currentTime = clampTime(media, media.currentTime - SEEK_SMALL_S);
      break;
    case "ArrowRight":
      media.currentTime = clampTime(media, media.currentTime + SEEK_SMALL_S);
      break;
    case "ArrowUp":
      media.volume = Math.min(1, Math.round((media.volume + VOLUME_STEP) * 10) / 10);
      break;
    case "ArrowDown":
      media.volume = Math.max(0, Math.round((media.volume - VOLUME_STEP) * 10) / 10);
      break;
    default:
      return false;
  }
  event.preventDefault();
  return true;
}

function buildMedia(doc: Document, data: ShareData): HTMLMediaElement | null {
  const media = data.media;
  if (media === null) return null;
  const urls = shareUrls(data.token);
  if (media.kind === "audio") {
    const audio = el(doc, "audio", "share-audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = urls.audio;
    return audio;
  }
  const video = el(doc, "video", "share-video");
  video.controls = true;
  video.preload = "metadata";
  video.setAttribute("playsinline", "");
  if (data.thumbnail) video.setAttribute("poster", urls.thumbnail);
  const source = doc.createElement("source");
  source.src = urls.video;
  source.type = media.mime;
  video.append(source);
  const preferred = defaultCaption(data.captions);
  for (const caption of data.captions) {
    const track = doc.createElement("track");
    track.kind = "captions";
    track.srclang = caption.lang;
    track.label = caption.label;
    track.src = urls.captions(caption.lang);
    if (caption === preferred) track.default = true;
    video.append(track);
  }
  return video;
}

function downloadLink(doc: Document, href: string, label: string, detail?: string): HTMLElement {
  const link = el(doc, "a", "share-download");
  link.href = href;
  link.setAttribute("download", "");
  link.setAttribute("rel", "nofollow");
  link.append(el(doc, "span", "share-download__label", label));
  if (detail !== undefined && detail !== "") {
    link.append(el(doc, "span", "share-download__detail", detail));
  }
  return link;
}

function buildDownloads(doc: Document, data: ShareData): HTMLElement {
  const urls = shareUrls(data.token);
  const section = el(doc, "section", "share-downloads");
  section.setAttribute("aria-label", "Downloads");
  section.append(el(doc, "h2", "share-section-title", "Download"));
  const list = el(doc, "div", "share-downloads__list");
  const media = data.media;
  if (data.downloads.video !== undefined) {
    const detail = [
      media?.kind === "video" && media.height !== null ? `${media.height}p` : "",
      media?.kind === "video" ? formatBytes(media.size_bytes) : "",
    ]
      .filter((part) => part !== "")
      .join(", ");
    list.append(downloadLink(doc, urls.download(urls.video), "Video", detail));
  }
  if (data.downloads.audio !== undefined) {
    const detail = media?.kind === "audio" ? formatBytes(media.size_bytes) : "";
    list.append(downloadLink(doc, urls.download(urls.audio), "Audio", detail));
  }
  for (const caption of data.captions) {
    list.append(
      downloadLink(doc, urls.download(urls.captions(caption.lang)), "Captions", caption.label),
    );
  }
  list.append(downloadLink(doc, urls.download(urls.metadata), "Metadata", "JSON"));
  section.append(list);
  return section;
}

function buildDescription(doc: Document, text: string | null): HTMLElement | null {
  if (text === null || text.trim() === "") return null;
  const details = el(doc, "details", "share-description");
  details.append(el(doc, "summary", "share-description__summary", "Description"));
  details.append(el(doc, "p", "share-description__text", text));
  return details;
}

function buildFooter(doc: Document): HTMLElement {
  const footer = el(doc, "footer", "share-footer");
  footer.append(el(doc, "span", "", "Shared from cellar"));
  for (const [href, label] of [
    ["/s/privacy", "Privacy"],
    ["/s/tos", "Terms"],
  ] as const) {
    const link = el(doc, "a", "share-footer__link", label);
    link.href = href;
    footer.append(link);
  }
  return footer;
}

/** Render the share view into `root`. Returns the media element, if any. */
export function renderPlayer(
  root: HTMLElement,
  doc: Document,
  data: ShareData,
): HTMLMediaElement | null {
  const title = data.video.title !== null && data.video.title !== "" ? data.video.title : null;
  doc.title = title ?? "Shared video";

  const main = el(doc, "main", "share-player");
  const stage = el(doc, "div", "share-stage");
  const media = buildMedia(doc, data);
  if (media === null) {
    stage.append(el(doc, "p", "share-unavailable", "The media file is not available."));
  } else {
    stage.append(media);
  }
  main.append(stage);

  const info = el(doc, "div", "share-info");
  const header = el(doc, "div", "share-header");
  header.append(el(doc, "h1", "share-player__title", title ?? "Shared video"));
  if (media !== null) header.append(buildSpeedMenu(doc, media));
  info.append(header);

  const facts = [
    data.video.channel_title,
    formatDate(data.video.upload_date),
    formatDuration(data.video.duration_s),
  ].filter((fact): fact is string => fact !== null && fact !== "");
  if (facts.length > 0) {
    const line = el(doc, "p", "share-facts");
    for (const fact of facts) line.append(el(doc, "span", "share-fact", fact));
    info.append(line);
  }
  const counts = [
    formatCount(data.video.views, "view", "views"),
    formatCount(data.video.likes, "like", "likes"),
  ].filter((count): count is string => count !== null);
  if (counts.length > 0) {
    const line = el(doc, "p", "share-counts");
    for (const count of counts) line.append(el(doc, "span", "share-fact", count));
    info.append(line);
  }
  const description = buildDescription(doc, data.video.description);
  if (description !== null) info.append(description);
  info.append(buildDownloads(doc, data));
  main.append(info);

  root.replaceChildren(main, buildFooter(doc));
  root.classList.add("share-root--player");
  if (media !== null) {
    doc.addEventListener("keydown", (event) => {
      handleShortcut(event, media);
    });
  }
  return media;
}
