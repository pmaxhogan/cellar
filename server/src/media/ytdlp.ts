import {
  buildYtDlpFormat,
  buildYtDlpFormatSort,
  isAllowlistedYtdlpArg,
  type EffectiveSettings,
  type ResolvedSettings,
  type YtDlpFormatInput,
} from "@cellar/shared";

/**
 * yt-dlp argv construction and output parsing for the download pipeline.
 * Pure functions: no IO, no logging. docs/ARCHITECTURE.md "Download".
 *
 * Decisions (open call 2 and the audio-only rule):
 * - The bgutil PO token plugin is loaded with `--plugin-dirs <dir>` (one flag
 *   per dir) and pointed at the sidecar with
 *   `--extractor-args youtubepot-bgutilhttp:base_url=<url>`; Node is passed
 *   as `--js-runtimes node` (both verified in the image, see the Dockerfile).
 * - Progress: `--newline --progress` plus a progress template carrying a
 *   `cellar-progress` marker, because the `download:` prefix of
 *   `--progress-template` selects the progress type and is not printed.
 *   parseProgress also understands yt-dlp's native `[download]  25.0% of`
 *   lines, so an older build or a template change still reports progress.
 * - Result: `--print-json` (the info dict, last JSON line) plus
 *   `--print after_move:cellar-file:%(filepath)s`, which names the final
 *   merged file after every post-processor ran.
 * - `--sleep-requests` takes one value; cellar draws it uniformly from the
 *   configured min..max range per invocation, which keeps the "1-3 s"
 *   jitter across runs.
 * - audio_only selects `bestaudio[ext=webm]/bestaudio`: YouTube always offers
 *   an audio-only Opus/WebM (251) and an m4a (140) stream, so the original
 *   track is kept as is and `-x` (re-extraction through ffmpeg) is never
 *   needed. If no audio-only format exists yt-dlp fails the job visibly.
 * - Captions `languages: "all"` becomes `all,-live_chat`: live chat replays
 *   are not captions and can be very large.
 */

export const YOUTUBE_WATCH_URL = "https://www.youtube.com/watch?v=";
export const PROGRESS_MARKER = "cellar-progress";
export const FILE_MARKER = "cellar-file:";
export const PROGRESS_TEMPLATE = `download:${PROGRESS_MARKER} %(progress._percent_str)s %(progress.eta)s`;
export const AUDIO_ONLY_FORMAT = "bestaudio[ext=webm]/bestaudio";
export const POT_EXTRACTOR_ARG = "youtubepot-bgutilhttp:base_url=";

export interface DownloadArgsInput {
  effective: EffectiveSettings;
  video: { id: string };
  /** Directory the media and sidecars are written into. */
  outDir: string;
  cookiesPath?: string | null;
  proxyUrl?: string | null;
  settings: ResolvedSettings;
  /** PO token provider base URL; empty or null disables it. */
  potProviderUrl?: string | null;
  pluginDirs?: readonly string[];
  /** `--js-runtimes` value; null or empty omits the flag. */
  jsRuntime?: string | null;
  /** Source of randomness for the request sleep. Default Math.random. */
  random?: () => number;
}

export interface DownloadArgs {
  args: string[];
  /** Extra args a rule asked for that the allowlist rejected (logged by the caller). */
  rejectedExtraArgs: string[];
  /** True when no media is downloaded (captions_only, metadata_only). */
  skipMedia: boolean;
}

function roundSeconds(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** The `-f` selector for these settings, or null when no media is downloaded. */
export function formatSelector(effective: EffectiveSettings): string | null {
  if (effective.media_mode === "captions_only" || effective.media_mode === "metadata_only") {
    return null;
  }
  if (effective.media_mode === "audio_only") {
    return AUDIO_ONLY_FORMAT;
  }
  const override = effective.ytdlp.format_override;
  if (override !== undefined && override !== "") {
    return override;
  }
  return buildYtDlpFormat(formatInput(effective));
}

function formatInput(effective: EffectiveSettings): YtDlpFormatInput {
  return {
    format_policy: effective.format_policy,
    quality_priority: effective.quality_priority,
    max_height: effective.max_height,
    max_fps: effective.max_fps,
    media_mode: effective.media_mode,
  };
}

/** The `-S` sort for these settings (a quality ranking's codec tie-break), or null. */
export function formatSort(effective: EffectiveSettings): string | null {
  const override = effective.ytdlp.format_override;
  if (override !== undefined && override !== "") {
    return null;
  }
  return buildYtDlpFormatSort(formatInput(effective));
}

/** `--sub-langs` value for the captions effect. */
export function subLangs(languages: EffectiveSettings["captions"]["languages"]): string {
  return languages === "all" ? "all,-live_chat" : languages.join(",");
}

/** Arguments shared by every yt-dlp run: the PO token plugin and the JS runtime. */
export function commonArgs(input: {
  potProviderUrl?: string | null | undefined;
  pluginDirs?: readonly string[] | undefined;
  jsRuntime?: string | null | undefined;
}): string[] {
  const args: string[] = [];
  for (const dir of input.pluginDirs ?? []) {
    if (dir.trim() !== "") {
      args.push("--plugin-dirs", dir);
    }
  }
  if (input.jsRuntime !== undefined && input.jsRuntime !== null && input.jsRuntime !== "") {
    args.push("--js-runtimes", input.jsRuntime);
  }
  const pot = input.potProviderUrl?.trim() ?? "";
  if (pot !== "") {
    args.push("--extractor-args", `${POT_EXTRACTOR_ARG}${pot.replace(/\/+$/, "")}`);
  }
  return args;
}

/** Build the full download argv (URL last, after `--`). */
export function buildDownloadArgs(input: DownloadArgsInput): DownloadArgs {
  const { effective, settings } = input;
  const ytdlp = effective.ytdlp;
  const format = formatSelector(effective);
  const skipMedia = format === null;
  const random = input.random ?? Math.random;

  const args: string[] = [
    "--no-playlist",
    "--no-overwrites",
    "--newline",
    "--progress",
    "--progress-template",
    PROGRESS_TEMPLATE,
    "--print-json",
    "--no-simulate",
    "--print",
    `after_move:${FILE_MARKER}%(filepath)s`,
    "-o",
    `${input.outDir.replace(/[\\/]+$/, "")}/%(id)s.%(ext)s`,
    "--write-info-json",
    "--write-all-thumbnails",
  ];

  if (format === null) {
    args.push("--skip-download");
  } else {
    // Downgrades a failed subtitle fetch to a warning so the video still
    // lands; any real failure still exits non-zero. captions_only keeps
    // subtitle errors fatal, since there they are the whole job.
    args.push("--ignore-errors", "-f", format);
    const sort = formatSort(effective);
    if (sort !== null) {
      args.push("-S", sort);
    }
  }

  const captions = effective.captions;
  if (captions.enabled && effective.media_mode !== "metadata_only") {
    args.push("--write-subs");
    if (captions.auto_generated) {
      args.push("--write-auto-subs");
    }
    args.push(
      "--sub-langs",
      subLangs(captions.languages),
      "--sub-format",
      "vtt",
      "--convert-subs",
      "vtt",
    );
  }

  if (input.cookiesPath !== undefined && input.cookiesPath !== null) {
    args.push("--cookies", input.cookiesPath);
  }
  if (input.proxyUrl !== undefined && input.proxyUrl !== null && input.proxyUrl !== "") {
    args.push("--proxy", input.proxyUrl);
  }

  const sleepMin = ytdlp.sleep_requests_min ?? settings["download.sleep_requests_min_s"];
  const sleepMax = Math.max(
    sleepMin,
    ytdlp.sleep_requests_max ?? settings["download.sleep_requests_max_s"],
  );
  const sleep = sleepMin + (sleepMax - sleepMin) * random();
  if (sleep > 0) {
    args.push("--sleep-requests", roundSeconds(sleep));
  }

  const rate = ytdlp.rate_limit_bytes_per_s ?? settings["download.rate_limit_bytes_per_s"];
  if (rate !== null && rate !== undefined) {
    args.push("--limit-rate", String(rate));
  }
  if (ytdlp.concurrent_fragments !== undefined) {
    args.push("--concurrent-fragments", String(ytdlp.concurrent_fragments));
  }

  args.push(...commonArgs(input));

  if (effective.live === "record_live") {
    args.push("--live-from-start");
  }

  const rejectedExtraArgs: string[] = [];
  for (const extra of ytdlp.extra_args_allowlisted ?? []) {
    if (isAllowlistedYtdlpArg(extra)) {
      args.push(extra);
    } else {
      rejectedExtraArgs.push(extra);
    }
  }

  args.push("--", `${YOUTUBE_WATCH_URL}${input.video.id}`);
  return { args, rejectedExtraArgs, skipMedia };
}

export const CANARY_VIDEO_ID = "dQw4w9WgXcQ";

/** The canary: lowest quality, no cookies, no proxy, no sidecars, discarded afterwards. */
export function buildCanaryArgs(input: {
  outDir: string;
  potProviderUrl?: string | null;
  pluginDirs?: readonly string[];
  jsRuntime?: string | null;
}): string[] {
  return [
    "--no-playlist",
    "--no-overwrites",
    "--no-progress",
    "-f",
    "worst",
    "-o",
    `${input.outDir.replace(/[\\/]+$/, "")}/%(id)s.%(ext)s`,
    ...commonArgs(input),
    "--",
    `${YOUTUBE_WATCH_URL}${CANARY_VIDEO_ID}`,
  ];
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

export interface Progress {
  pct: number;
  /** Seconds remaining, when yt-dlp knows. */
  etaS: number | null;
}

const TEMPLATE_RE = new RegExp(`^${PROGRESS_MARKER}\\s+([\\d.]+)%\\s*(\\S+)?`);
const NATIVE_RE = /^\[download\]\s+([\d.]+)%/;

/** Parse one stdout line into a progress value, or null when it is not one. */
export function parseProgress(line: string): Progress | null {
  const trimmed = line.trim();
  const templated = TEMPLATE_RE.exec(trimmed);
  if (templated !== null) {
    const pct = Number(templated[1]);
    const eta = templated[2] === undefined ? Number.NaN : Number(templated[2]);
    return Number.isFinite(pct)
      ? { pct: Math.min(100, pct), etaS: Number.isFinite(eta) ? eta : null }
      : null;
  }
  const native = NATIVE_RE.exec(trimmed);
  if (native !== null) {
    const pct = Number(native[1]);
    return Number.isFinite(pct) ? { pct: Math.min(100, pct), etaS: null } : null;
  }
  return null;
}

/** The info dict `--print-json` printed: the last stdout line that parses to an object with an id. */
export function parsePrintJson(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] as string).trim();
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        typeof (parsed as { id?: unknown }).id === "string"
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON after all; keep looking.
    }
  }
  return null;
}

/** The final file `--print after_move:cellar-file:...` named, if any. */
export function parsePrintedFile(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] as string).trim();
    if (line.startsWith(FILE_MARKER)) {
      const path = line.slice(FILE_MARKER.length).trim();
      if (path !== "" && path !== "NA") {
        return path;
      }
    }
  }
  return null;
}

/** Candidate media paths from the info dict, best first. */
export function infoFilePaths(info: Record<string, unknown> | null): string[] {
  if (info === null) {
    return [];
  }
  const out: string[] = [];
  const downloads = info.requested_downloads;
  if (Array.isArray(downloads)) {
    for (const entry of downloads) {
      const path = (entry as { filepath?: unknown } | null)?.filepath;
      if (typeof path === "string") {
        out.push(path);
      }
    }
  }
  for (const key of ["filepath", "_filename", "filename"]) {
    const value = info[key];
    if (typeof value === "string") {
      out.push(value);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Logging and failures
// ---------------------------------------------------------------------------

/** Mask userinfo in anything URL-shaped (`scheme://user:pass@host` -> `scheme://***@host`). */
export function redactUrl(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");
}

/**
 * A copy of argv that is safe to log: the proxy URL loses its credentials
 * (the host stays, which is useful when debugging), anything else URL-shaped
 * is masked the same way. The cookies PATH stays; its contents never enter argv.
 */
export function redactArgv(argv: readonly string[]): string[] {
  return argv.map((arg, index) => {
    if (index > 0 && argv[index - 1] === "--proxy") {
      try {
        const url = new URL(arg);
        return `${url.protocol}//${url.username === "" && url.password === "" ? "" : "***@"}${url.host}`;
      } catch {
        return "[proxy]";
      }
    }
    return redactUrl(arg);
  });
}

export type YtdlpFailureKind =
  "bot_wall" | "unavailable" | "rate_limited" | "auth" | "network" | "captions" | "unknown";

export interface YtdlpFailure {
  kind: YtdlpFailureKind;
  /** For `unavailable`: what to record in videos.privacy. */
  privacy?: "private" | "removed" | "unavailable";
  /** The most relevant ERROR line, credentials masked. */
  message: string;
  /** Retrying cannot help (the video is gone). */
  permanent: boolean;
}

const RULES: readonly {
  kind: YtdlpFailureKind;
  re: RegExp;
  privacy?: YtdlpFailure["privacy"];
}[] = [
  { kind: "bot_wall", re: /confirm you.?re not a bot|confirm you are not a bot/i },
  { kind: "unavailable", re: /\bPrivate video\b/i, privacy: "private" },
  {
    kind: "unavailable",
    re: /removed by the uploader|has been removed|account associated with this video has been terminated|no longer available because/i,
    privacy: "removed",
  },
  {
    kind: "unavailable",
    re: /Video unavailable|This video is unavailable|not made this video available in your country|is not available in your country/i,
    privacy: "unavailable",
  },
  { kind: "rate_limited", re: /HTTP Error 429|Too Many Requests|rate.?limit/i },
  {
    kind: "auth",
    re: /confirm your age|members-only|Join this channel|login required|cookies are no longer valid|Sign in to/i,
  },
  {
    kind: "network",
    re: /Unable to download (webpage|API page|video data)|Connection (refused|reset|aborted|timed out)|timed out|Temporary failure in name resolution|Name or service not known|getaddrinfo|Network is unreachable|ProxyError|Tunnel connection failed|Cannot connect to proxy|EOF occurred|Remote end closed|No route to host|SSL:/i,
  },
];

/**
 * A subtitle fetch failure. timedtext answers 429 far more readily than the
 * video endpoints and says nothing about the video itself, so these lines
 * never feed the rules: a subtitle 429 must not pause every download.
 */
const SUBTITLE_FAILURE = /Unable to download (video |automatic )?subtitles/i;

/** Classify a failed run from its stderr (and stdout, for builds that print errors there). */
export function classifyFailure(stderr: string, stdout = ""): YtdlpFailure {
  const text = `${stderr}\n${stdout}`;
  const ruleText = text
    .split(/\r?\n/)
    .filter((line) => !SUBTITLE_FAILURE.test(line))
    .join("\n");
  const errorLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("ERROR:"))
      .pop() ??
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .pop() ??
    "yt-dlp failed without output";
  const message = redactUrl(errorLine).slice(0, 500);
  for (const rule of RULES) {
    if (rule.re.test(ruleText)) {
      return {
        kind: rule.kind,
        message,
        permanent: rule.kind === "unavailable",
        ...(rule.privacy === undefined ? {} : { privacy: rule.privacy }),
      };
    }
  }
  if (SUBTITLE_FAILURE.test(errorLine)) {
    return { kind: "captions", message, permanent: false };
  }
  return { kind: "unknown", message, permanent: false };
}

// ---------------------------------------------------------------------------
// Tool settings
// ---------------------------------------------------------------------------

/** The registry default of `tools.pot_provider_url`. */
export const DEFAULT_POT_PROVIDER_URL = "http://bgutil:4416";

/**
 * PO token provider, plugin dirs and JS runtime for a run. The provider URL
 * setting wins when the owner changed it (empty disables); while it is still
 * the registry default, POT_PROVIDER_URL from the environment seeds it.
 */
export function ytdlpToolOptions(
  settings: Pick<ResolvedSettings, "tools.pot_provider_url" | "tools.js_runtime">,
  config: { potProviderUrl: string; ytdlpPluginDirs: string },
): { potProviderUrl: string; pluginDirs: string[]; jsRuntime: string } {
  const setting = settings["tools.pot_provider_url"];
  const potProviderUrl = setting === DEFAULT_POT_PROVIDER_URL ? config.potProviderUrl : setting;
  const dirs = config.ytdlpPluginDirs.trim();
  return {
    potProviderUrl,
    pluginDirs: dirs === "" ? [] : [dirs],
    jsRuntime: settings["tools.js_runtime"],
  };
}
