// Canned data for the yt-dlp shim: well-known public videos, flat playlist entries and a
// realistic (but invented-numbers) info dict. Used by yt-dlp.mjs only.
import { createHash } from "node:crypto";

export const FAKE_YTDLP_VERSION = "2026.08.19-fake";

/** The three ids the default flat playlist is made of. */
export const DEFAULT_PLAYLIST_IDS = ["dQw4w9WgXcQ", "jNQXAC9IVRw", "9bZkp7q19f0"];

const KNOWN = {
  dQw4w9WgXcQ: {
    title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
    duration: 213,
    channelId: "UCuAXFkgsw1L7xaCfnd5JJOw",
    channel: "Rick Astley",
    handle: "@RickAstleyYT",
    published: "2009-10-25T06:57:33Z",
    views: 1_650_000_000,
    likes: 18_700_000,
    comments: 2_400_000,
    followers: 4_300_000,
    categories: ["Music"],
    tags: ["rick astley", "never gonna give you up", "nggyu", "rickroll"],
  },
  jNQXAC9IVRw: {
    title: "Me at the zoo",
    duration: 19,
    channelId: "UC4QobU6STFB0P71PMvOGN5A",
    channel: "jawed",
    handle: "@jawed",
    published: "2005-04-24T03:31:52Z",
    views: 340_000_000,
    likes: 14_000_000,
    comments: 11_000_000,
    followers: 4_000_000,
    categories: ["People & Blogs"],
    tags: ["jawed karim", "elephant", "zoo"],
  },
  "9bZkp7q19f0": {
    title: "PSY - GANGNAM STYLE M/V",
    duration: 252,
    channelId: "UCrDkAvwZum-UTjHmzDI2iIw",
    channel: "officialpsy",
    handle: "@officialpsy",
    published: "2012-07-15T07:46:32Z",
    views: 5_500_000_000,
    likes: 30_000_000,
    comments: 5_000_000,
    followers: 18_000_000,
    categories: ["Music"],
    tags: ["psy", "gangnam style", "kpop"],
  },
  aircAruvnKk: {
    title: "But what is a neural network? | Deep learning chapter 1",
    duration: 1104,
    channelId: "UCYO_jab_esuFRV4b17AJtAw",
    channel: "3Blue1Brown",
    handle: "@3blue1brown",
    published: "2017-10-05T14:00:12Z",
    views: 18_000_000,
    likes: 450_000,
    comments: 12_000,
    followers: 6_900_000,
    categories: ["Education"],
    tags: ["neural network", "deep learning", "3blue1brown"],
  },
  WUvTyaaNkzM: {
    title: "The essence of calculus | Chapter 1",
    duration: 1002,
    channelId: "UCYO_jab_esuFRV4b17AJtAw",
    channel: "3Blue1Brown",
    handle: "@3blue1brown",
    published: "2017-04-29T15:41:20Z",
    views: 11_000_000,
    likes: 350_000,
    comments: 9_000,
    followers: 6_900_000,
    categories: ["Education"],
    tags: ["calculus", "mathematics", "3blue1brown"],
  },
  "IHZwWFHWa-w": {
    title: "Gradient descent, how neural networks learn | Deep Learning Chapter 2",
    duration: 1257,
    channelId: "UCYO_jab_esuFRV4b17AJtAw",
    channel: "3Blue1Brown",
    handle: "@3blue1brown",
    published: "2017-10-16T15:00:03Z",
    views: 8_000_000,
    likes: 210_000,
    comments: 5_000,
    followers: 6_900_000,
    categories: ["Education"],
    tags: ["gradient descent", "deep learning", "3blue1brown"],
  },
  HeQX2HjkcNo: {
    title: "Math's Fundamental Flaw",
    duration: 2050,
    channelId: "UCHnyfMqiRRG1u-2MsSQLbXA",
    channel: "Veritasium",
    handle: "@veritasium",
    published: "2021-05-22T14:00:08Z",
    views: 26_000_000,
    likes: 820_000,
    comments: 40_000,
    followers: 15_000_000,
    categories: ["Education"],
    tags: ["mathematics", "godel", "veritasium"],
  },
};

/** @param {string} id */
function shortHash(id, length) {
  return createHash("sha256").update(id).digest("base64url").slice(0, length);
}

/**
 * Metadata for any id: the table above, or a stable synthetic entry.
 * @param {string} id
 */
export function videoMeta(id) {
  const known = KNOWN[id];
  if (known) return { id, ...known, publishedMs: Date.parse(known.published) };
  const published = "2024-01-15T12:00:00Z";
  return {
    id,
    title: `Fake video ${id}`,
    duration: 120,
    channelId: `UC${shortHash(id, 22)}`,
    channel: "Fake Channel",
    handle: "@fakechannel",
    published,
    publishedMs: Date.parse(published),
    views: 1234,
    likes: 56,
    comments: 7,
    followers: 890,
    categories: ["Entertainment"],
    tags: ["fake"],
  };
}

/**
 * Pull an 11 character video id out of a URL or a bare id.
 * @param {string} s
 * @returns {string | null}
 */
export function extractVideoId(s) {
  const patterns = [
    /[?&]v=([\w-]{11})(?![\w-])/,
    /youtu\.be\/([\w-]{11})(?![\w-])/,
    /\/(?:shorts|embed|live|v)\/([\w-]{11})(?![\w-])/,
    /^([\w-]{11})$/,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) return m[1] ?? null;
  }
  return null;
}

/** @param {string} id */
export function thumbnailVariants(id) {
  const base = `https://i.ytimg.com/vi/${id}`;
  return [
    { url: `${base}/default.jpg`, height: 90, width: 120, preference: -37, id: "0" },
    { url: `${base}/mqdefault.jpg`, height: 180, width: 320, preference: -33, id: "1" },
    { url: `${base}/hqdefault.jpg`, height: 360, width: 480, preference: -29, id: "2" },
    { url: `${base}/sddefault.jpg`, height: 480, width: 640, preference: -25, id: "3" },
    { url: `${base}/hq720.jpg`, height: 720, width: 1280, preference: -21, id: "4" },
    { url: `${base}/maxresdefault.jpg`, height: 1080, width: 1920, preference: -17, id: "5" },
  ].map((t) => ({ ...t, resolution: `${t.width}x${t.height}` }));
}

/**
 * One flat-playlist entry, shaped like `yt-dlp -J --flat-playlist` output.
 * @param {string} id
 * @param {Record<string, any>} [overrides]
 */
export function flatEntry(id, overrides = {}) {
  const meta = videoMeta(id);
  const thumbs = thumbnailVariants(id).filter((t) => t.height <= 360);
  return {
    _type: "url",
    ie_key: "Youtube",
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: meta.title,
    description: null,
    duration: meta.duration,
    channel_id: meta.channelId,
    channel: meta.channel,
    channel_url: `https://www.youtube.com/channel/${meta.channelId}`,
    uploader: meta.channel,
    uploader_id: meta.handle,
    uploader_url: `https://www.youtube.com/${meta.handle}`,
    thumbnails: thumbs.map(({ url, height, width }) => ({ url, height, width })),
    timestamp: null,
    release_timestamp: null,
    availability: null,
    view_count: meta.views,
    live_status: null,
    channel_is_verified: true,
    __x_forwarded_for_ip: null,
    ...overrides,
  };
}

/**
 * A flat playlist document.
 * @param {{ kind: string, target: string, entries: object[] }} p
 */
export function flatPlaylist({ kind, target, entries }) {
  const named =
    kind === "history"
      ? { id: "history", title: "history", uploader: null }
      : kind === "watchlater"
        ? { id: "WL", title: "Watch later", uploader: null }
        : { id: "PLfakefakefakefakefakefakefakefake", title: "Fake playlist", uploader: "Fake" };
  const url =
    kind === "history"
      ? "https://www.youtube.com/feed/history"
      : kind === "watchlater"
        ? "https://www.youtube.com/playlist?list=WL"
        : target;
  return {
    id: named.id,
    title: named.title,
    availability: kind === "default" ? "public" : "private",
    channel_follower_count: null,
    description: "",
    tags: [],
    thumbnails: [],
    modified_date: null,
    view_count: null,
    playlist_count: entries.length,
    channel: named.uploader,
    channel_id: null,
    uploader_id: null,
    uploader: named.uploader,
    uploader_url: null,
    channel_url: null,
    _type: "playlist",
    entries,
    webpage_url: url,
    original_url: target,
    webpage_url_basename: "playlist",
    webpage_url_domain: "youtube.com",
    extractor_key: "YoutubeTab",
    extractor: "youtube:tab",
    release_year: null,
    epoch: Math.floor(Date.now() / 1000),
  };
}

const VCODEC = {
  av01: { vcodec: "av01.0.08M.08", container: "webm_dash", ext: "webm", ids: [399, 398] },
  vp09: { vcodec: "vp09.00.40.08", container: "webm_dash", ext: "webm", ids: [248, 247] },
  avc1: { vcodec: "avc1.640028", container: "mp4_dash", ext: "mp4", ids: [137, 136] },
};

/**
 * Normalise a user supplied codec name to av01 | vp09 | avc1.
 * @param {string | undefined} name
 */
export function normaliseVcodec(name) {
  const n = (name ?? "av01").toLowerCase();
  if (n.startsWith("av01") || n === "av1") return "av01";
  if (n.startsWith("vp09") || n === "vp9" || n === "vp09") return "vp09";
  if (n.startsWith("avc") || n === "h264") return "avc1";
  return "av01";
}

/** The container extension yt-dlp would pick for a vcodec family. */
export function extForVcodec(family) {
  return VCODEC[family].ext;
}

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) fake",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-us,en;q=0.5",
  "Sec-Fetch-Mode": "navigate",
};

/** @param {string} id */
function fakeStreamUrl(id, itag) {
  return `https://rr1---sn-fakefake.googlevideo.com/videoplayback?expire=1797000000&ei=fake&id=${id}&itag=${itag}&source=youtube`;
}

/**
 * The formats array of an info dict.
 * @param {string} id
 * @param {number} duration
 */
export function buildFormats(id, duration) {
  const audio = (itag, ext, acodec, abr, asr, note, size) => ({
    format_id: String(itag),
    format_note: note,
    ext,
    protocol: "https",
    acodec,
    vcodec: "none",
    url: fakeStreamUrl(id, itag),
    width: null,
    height: null,
    fps: null,
    abr,
    asr,
    tbr: abr,
    audio_channels: 2,
    language: "en",
    language_preference: -1,
    quality: 3,
    has_drm: false,
    source_preference: -1,
    filesize: size,
    filesize_approx: size,
    format: `${itag} - audio only (${note})`,
    resolution: "audio only",
    audio_ext: ext === "webm" ? "webm" : "m4a",
    video_ext: "none",
    container: ext === "webm" ? "webm_dash" : "m4a_dash",
    dynamic_range: null,
    downloader_options: { http_chunk_size: 10485760 },
    http_headers: HEADERS,
  });
  const video = (itag, family, height, fps, vbr) => {
    const spec = VCODEC[family];
    const width = Math.round((height * 16) / 9 / 2) * 2;
    const size = Math.round((vbr * 1000 * duration) / 8);
    return {
      format_id: String(itag),
      format_note: `${height}p`,
      ext: spec.ext,
      protocol: "https",
      acodec: "none",
      vcodec: spec.vcodec,
      url: fakeStreamUrl(id, itag),
      width,
      height,
      fps,
      vbr,
      tbr: vbr,
      quality: height >= 1080 ? 9 : 7,
      has_drm: false,
      source_preference: -1,
      filesize: size,
      filesize_approx: size,
      format: `${itag} - ${width}x${height} (${height}p)`,
      resolution: `${width}x${height}`,
      aspect_ratio: 1.78,
      audio_ext: "none",
      video_ext: spec.ext,
      container: spec.container,
      dynamic_range: "SDR",
      downloader_options: { http_chunk_size: 10485760 },
      http_headers: HEADERS,
    };
  };
  const storyboard = (n, width, height, fragments) => ({
    format_id: `sb${n}`,
    format_note: "storyboard",
    ext: "mhtml",
    protocol: "mhtml",
    acodec: "none",
    vcodec: "none",
    url: `https://i.ytimg.com/sb/${id}/storyboard3_L${n}/M$M.jpg?sqp=fake`,
    width,
    height,
    fps: 0.1,
    rows: 5,
    columns: 5,
    fragments: Array.from({ length: fragments }, (_, i) => ({
      url: `https://i.ytimg.com/sb/${id}/storyboard3_L${n}/M${i}.jpg?sqp=fake`,
      duration: 100,
    })),
    resolution: `${width}x${height}`,
    aspect_ratio: 1.78,
    format: `sb${n} - ${width}x${height} (storyboard)`,
    audio_ext: "none",
    video_ext: "none",
    dynamic_range: null,
    http_headers: HEADERS,
  });
  const combined = {
    format_id: "18",
    format_note: "360p",
    ext: "mp4",
    protocol: "https",
    acodec: "mp4a.40.2",
    vcodec: "avc1.42001E",
    url: fakeStreamUrl(id, 18),
    width: 640,
    height: 360,
    fps: 30,
    tbr: 560,
    abr: 96,
    asr: 44100,
    audio_channels: 2,
    quality: 6,
    has_drm: false,
    source_preference: -1,
    filesize_approx: Math.round((560 * 1000 * duration) / 8),
    format: "18 - 640x360 (360p)",
    resolution: "640x360",
    aspect_ratio: 1.78,
    audio_ext: "m4a",
    video_ext: "mp4",
    container: "mp4",
    dynamic_range: "SDR",
    http_headers: HEADERS,
  };
  const sz = (kbps) => Math.round((kbps * 1000 * duration) / 8);
  return [
    storyboard(1, 80, 45, 3),
    storyboard(0, 160, 90, 1),
    audio(139, "m4a", "mp4a.40.5", 48.8, 22050, "low", sz(49)),
    audio(249, "webm", "opus", 50.4, 48000, "low", sz(50)),
    audio(250, "webm", "opus", 66.2, 48000, "low", sz(66)),
    audio(140, "m4a", "mp4a.40.2", 129.5, 44100, "medium", sz(129)),
    audio(251, "webm", "opus", 135.1, 48000, "medium", sz(135)),
    combined,
    video(136, "avc1", 720, 30, 1180),
    video(247, "vp09", 720, 30, 1010),
    video(398, "av01", 720, 30, 790),
    video(137, "avc1", 1080, 30, 2640),
    video(248, "vp09", 1080, 30, 1830),
    video(399, "av01", 1080, 30, 1320),
  ];
}

/** @param {string} id */
export function buildSubtitles(id) {
  const exts = ["vtt", "ttml", "srv3", "srv2", "srv1", "json3"];
  const tracks = (lang, name, extra = "") =>
    exts.map((ext) => ({
      ext,
      url: `https://www.youtube.com/api/timedtext?v=${id}&lang=${lang}&fmt=${ext}${extra}`,
      name,
    }));
  return {
    subtitles: { en: tracks("en", "English") },
    automatic_captions: {
      en: tracks("en", "English (auto-generated)", "&kind=asr"),
      "en-orig": tracks("en", "English (Original)", "&kind=asr&tlang=en-orig"),
      de: tracks("en", "German", "&tlang=de"),
      es: tracks("en", "Spanish", "&tlang=es"),
      fr: tracks("en", "French", "&tlang=fr"),
    },
  };
}

/**
 * A full info dict as printed by `yt-dlp --dump-single-json` / `--print-json`.
 *
 * @param {string} id
 * @param {{
 *   vcodec?: string,
 *   ext?: string,
 *   height?: number,
 *   audioOnly?: boolean,
 *   filesize?: number,
 *   filename?: string,
 *   epoch?: number,
 *   overrides?: Record<string, any>,
 * }} [opts]
 */
export function buildInfo(id, opts = {}) {
  const meta = videoMeta(id);
  const family = normaliseVcodec(opts.vcodec);
  const spec = VCODEC[family];
  const height = Math.min(opts.height ?? 1080, 1080);
  const width = Math.round((height * 16) / 9 / 2) * 2;
  const audioOnly = Boolean(opts.audioOnly);
  const ext = opts.ext ?? (audioOnly ? "webm" : spec.ext);
  const mp4Family = ext === "mp4" || family === "avc1";
  const audioItag = mp4Family ? 140 : 251;
  const videoItag = height >= 1080 ? spec.ids[0] : spec.ids[1];
  const formats = buildFormats(id, meta.duration);
  const find = (itag) => formats.find((f) => f.format_id === String(itag));
  const requested = audioOnly ? [find(audioItag)] : [find(videoItag), find(audioItag)];
  const published = new Date(meta.publishedMs);
  const pad = (n) => String(n).padStart(2, "0");
  const uploadDate = `${published.getUTCFullYear()}${pad(published.getUTCMonth() + 1)}${pad(published.getUTCDate())}`;
  const mins = Math.floor(meta.duration / 60);
  const secs = meta.duration % 60;
  const captions = buildSubtitles(id);
  const thumbs = thumbnailVariants(id);
  const url = `https://www.youtube.com/watch?v=${id}`;
  const acodec = mp4Family ? "mp4a.40.2" : "opus";
  const filepath = opts.filename;
  const info = {
    id,
    title: meta.title,
    fulltitle: meta.title,
    formats,
    thumbnails: thumbs,
    thumbnail: thumbs[thumbs.length - 1].url,
    description: `Synthetic description for ${meta.title}.\n\nGenerated by the cellar fake yt-dlp shim.`,
    channel_id: meta.channelId,
    channel_url: `https://www.youtube.com/channel/${meta.channelId}`,
    duration: meta.duration,
    view_count: meta.views,
    average_rating: null,
    age_limit: 0,
    webpage_url: url,
    categories: meta.categories,
    tags: meta.tags,
    playable_in_embed: true,
    live_status: "not_live",
    media_type: "video",
    release_timestamp: null,
    _format_sort_fields: [
      "quality",
      "res",
      "fps",
      "hdr:12",
      "source",
      "vcodec",
      "channels",
      "acodec",
    ],
    automatic_captions: captions.automatic_captions,
    subtitles: captions.subtitles,
    comment_count: meta.comments,
    chapters: null,
    heatmap: null,
    like_count: meta.likes,
    channel: meta.channel,
    channel_follower_count: meta.followers,
    channel_is_verified: true,
    uploader: meta.channel,
    uploader_id: meta.handle,
    uploader_url: `https://www.youtube.com/${meta.handle}`,
    upload_date: uploadDate,
    timestamp: Math.floor(meta.publishedMs / 1000),
    availability: "public",
    original_url: url,
    webpage_url_basename: "watch",
    webpage_url_domain: "youtube.com",
    extractor: "youtube",
    extractor_key: "Youtube",
    playlist: null,
    playlist_index: null,
    display_id: id,
    duration_string: `${mins}:${pad(secs)}`,
    is_live: false,
    was_live: false,
    requested_subtitles: null,
    _has_drm: null,
    epoch: opts.epoch ?? Math.floor(Date.now() / 1000),
    requested_downloads: [
      {
        requested_formats: requested,
        format: requested.map((f) => f.format).join("+"),
        format_id: requested.map((f) => f.format_id).join("+"),
        ext,
        protocol: "https+https",
        language: "en",
        format_note: audioOnly ? "medium" : `${height}p`,
        filesize_approx: opts.filesize ?? null,
        tbr: requested.reduce((sum, f) => sum + (f.tbr ?? 0), 0),
        width: audioOnly ? null : width,
        height: audioOnly ? null : height,
        resolution: audioOnly ? "audio only" : `${width}x${height}`,
        fps: audioOnly ? null : 30,
        dynamic_range: audioOnly ? null : "SDR",
        vcodec: audioOnly ? "none" : spec.vcodec,
        vbr: audioOnly ? null : (find(videoItag)?.vbr ?? null),
        stretched_ratio: null,
        aspect_ratio: audioOnly ? null : 1.78,
        acodec,
        abr: find(audioItag)?.abr ?? null,
        asr: find(audioItag)?.asr ?? null,
        audio_channels: 2,
        _filename: filepath,
        filename: filepath,
        ...(filepath ? { filepath } : {}),
      },
    ],
    format: requested.map((f) => f.format).join("+"),
    format_id: requested.map((f) => f.format_id).join("+"),
    ext,
    protocol: "https+https",
    language: "en",
    format_note: audioOnly ? "medium" : `${height}p`,
    filesize_approx: opts.filesize ?? null,
    tbr: requested.reduce((sum, f) => sum + (f.tbr ?? 0), 0),
    width: audioOnly ? null : width,
    height: audioOnly ? null : height,
    resolution: audioOnly ? "audio only" : `${width}x${height}`,
    fps: audioOnly ? null : 30,
    dynamic_range: audioOnly ? null : "SDR",
    vcodec: audioOnly ? "none" : spec.vcodec,
    vbr: audioOnly ? null : (find(videoItag)?.vbr ?? null),
    aspect_ratio: audioOnly ? null : 1.78,
    acodec,
    abr: find(audioItag)?.abr ?? null,
    asr: find(audioItag)?.asr ?? null,
    audio_channels: 2,
    _type: "video",
    _version: {
      version: FAKE_YTDLP_VERSION,
      current_git_head: null,
      release_git_head: "0000000000000000000000000000000000000000",
      repository: "yt-dlp/yt-dlp",
    },
    ...(filepath ? { _filename: filepath, filename: filepath } : {}),
    ...opts.overrides,
  };
  return info;
}

/** Help text for `--help`; includes the flags the server probes for. */
export const HELP_TEXT = `Usage: yt-dlp [OPTIONS] URL [URL...]

Options:
  General Options:
    -h, --help                      Print this help text and exit
    --version                       Print program version and exit
    -U, --update                    Update this program to the latest version
    -i, --ignore-errors             Ignore download and postprocessing errors
    --js-runtimes RUNTIME[:PATH]    Additional JavaScript runtime to enable, with
                                    an optional location for the runtime (either
                                    the path to the binary or its containing
                                    directory). This option can be used multiple
                                    times to enable multiple runtimes. Supported
                                    runtimes are (in order of priority, from
                                    highest to lowest): deno, node, quickjs, bun
    --no-js-runtimes                Clear JavaScript runtimes to enable,
                                    including defaults and those provided by
                                    previous --js-runtimes
    --extractor-args KEY:ARGS       Pass ARGS arguments to the KEY extractor.
                                    You can use this option multiple times to
                                    give arguments for different extractors

  Network Options:
    --proxy URL                     Use the specified HTTP/HTTPS/SOCKS proxy
    --source-address IP             Client-side IP address to bind to

  Video Selection:
    -I, --playlist-items ITEM_SPEC  Comma separated playlist_index of the items
                                    to download
    --playlist-end NUMBER           Last item to download (default: -1)
    --match-filters FILTER          Generic video filter

  Download Options:
    -r, --limit-rate RATE           Maximum download rate in bytes per second
    --sleep-requests SECONDS        Number of seconds to sleep between requests
                                    during data extraction
    --sleep-interval SECONDS        Number of seconds to sleep before each
                                    download
    --max-sleep-interval SECONDS    Maximum number of seconds to sleep
    --live-from-start               Download livestreams from the start

  Filesystem Options:
    -P, --paths [TYPES:]PATH        The paths where the files should be
                                    downloaded
    -o, --output [TYPES:]TEMPLATE   Output filename template
    --no-overwrites                 Do not overwrite any files
    --cookies FILE                  Netscape formatted file to read cookies from
                                    and dump cookie jar in
    --write-info-json               Write video metadata to a .info.json file
    --write-thumbnail               Write thumbnail image to disk
    --write-all-thumbnails          Write all thumbnail image formats to disk

  Verbosity and Simulation Options:
    -q, --quiet                     Activate quiet mode
    -s, --simulate                  Do not download the video
    --skip-download                 Do not download the video but write all
                                    related files
    -j, --dump-json                 Quiet, but print JSON information for each
                                    video
    -J, --dump-single-json          Quiet, but print JSON information for each
                                    url or infojson passed
    --print-json                    Be quiet and print the video information as
                                    JSON (video is still being downloaded)
    --flat-playlist                 Do not extract a playlist's URL result
                                    entries

  Video Format Options:
    -f, --format FORMAT             Video format code
    -S, --format-sort SORTORDER     Sort the formats by the fields given
    --merge-output-format FORMAT    Containers that may be used when merging
                                    formats

  Subtitle Options:
    --write-subs                    Write subtitle file
    --write-auto-subs               Write automatically generated subtitle file
    --sub-format FORMAT             Subtitle format
    --sub-langs LANGS               Languages of the subtitles to download

  Post-Processing Options:
    -x, --extract-audio             Convert video files to audio-only files
    --audio-format FORMAT           Format to convert the audio to
    --convert-subs FORMAT           Convert the subtitles to another format
`;
