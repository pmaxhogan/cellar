#!/usr/bin/env node
// Fake yt-dlp for cellar integration tests. No network, no real binary. See README.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import {
  DEFAULT_PLAYLIST_IDS,
  FAKE_YTDLP_VERSION,
  HELP_TEXT,
  buildInfo,
  extForVcodec,
  extractVideoId,
  flatEntry,
  flatPlaylist,
  normaliseVcodec,
  thumbnailVariants,
  videoMeta,
} from "./ytdlp-data.mjs";
import { formatBytes, loadConfig, recordArgv, sleep, writeRandomFile } from "./lib.mjs";

const SPEC = {
  fail: { env: "FAIL", type: "bool" },
  failIds: { env: "FAIL_IDS", type: "list" },
  failMessage: { env: "FAIL_MESSAGE", type: "str" },
  failExit: { env: "FAIL_EXIT", type: "int" },
  vcodec: { env: "VCODEC", type: "str" },
  bytes: { env: "BYTES", type: "int" },
  playlistFile: { env: "PLAYLIST_FILE", type: "str" },
  delayMs: { env: "DELAY_MS", type: "int" },
};

/** Options that consume the next argv element as their value. */
const VALUE_FLAGS = new Set([
  "-o",
  "--output",
  "-P",
  "--paths",
  "-f",
  "--format",
  "-S",
  "--format-sort",
  "--cookies",
  "--cookies-from-browser",
  "--proxy",
  "--sleep-requests",
  "--sleep-interval",
  "--min-sleep-interval",
  "--max-sleep-interval",
  "--sleep-subtitles",
  "--limit-rate",
  "-r",
  "--sub-langs",
  "--sub-format",
  "--convert-subs",
  "--convert-thumbnails",
  "--extractor-args",
  "--js-runtimes",
  "--playlist-end",
  "--playlist-start",
  "-I",
  "--playlist-items",
  "--print",
  "--retries",
  "-R",
  "--fragment-retries",
  "--extractor-retries",
  "--concurrent-fragments",
  "-N",
  "--merge-output-format",
  "--remux-video",
  "--recode-video",
  "--audio-format",
  "--audio-quality",
  "--user-agent",
  "--add-header",
  "--match-filters",
  "--match-filter",
  "--download-archive",
  "--cache-dir",
  "--ffmpeg-location",
  "--plugin-dirs",
  "--config-locations",
  "--socket-timeout",
  "--source-address",
  "--username",
  "-u",
  "--password",
  "-p",
  "--parse-metadata",
  "--replace-in-metadata",
  "--progress-template",
  "--compat-options",
  "--impersonate",
  "--downloader",
  "--exec",
  "--http-chunk-size",
  "--buffer-size",
  "--file-access-retries",
]);

const ALIASES = {
  "-o": "--output",
  "-P": "--paths",
  "-f": "--format",
  "-S": "--format-sort",
  "-r": "--limit-rate",
  "-I": "--playlist-items",
  "-R": "--retries",
  "-N": "--concurrent-fragments",
  "-u": "--username",
  "-p": "--password",
  "-J": "--dump-single-json",
  "-j": "--dump-json",
  "-x": "--extract-audio",
  "-q": "--quiet",
  "-s": "--simulate",
  "-h": "--help",
  "-i": "--ignore-errors",
  "-U": "--update",
  "--match-filter": "--match-filters",
};

/**
 * @param {string[]} argv
 * @returns {{ flags: Map<string, string[]>, positionals: string[] }}
 */
function parseArgv(argv) {
  /** @type {Map<string, string[]>} */
  const flags = new Map();
  /** @type {string[]} */
  const positionals = [];
  const push = (name, value) => {
    const key = ALIASES[name] ?? name;
    const list = flags.get(key) ?? [];
    list.push(value);
    flags.set(key, list);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--") && token.includes("=")) {
      const eq = token.indexOf("=");
      push(token.slice(0, eq), token.slice(eq + 1));
    } else if (token.startsWith("-") && token.length > 1) {
      if (VALUE_FLAGS.has(token)) {
        i += 1;
        push(token, argv[i] ?? "");
      } else {
        push(token, "");
      }
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

const argv = process.argv.slice(2);
recordArgv(process.env.FAKE_YTDLP_RECORD, argv);
const { flags, positionals } = parseArgv(argv);
const has = (name) => flags.has(name);
const last = (name) => flags.get(name)?.at(-1);

/** @type {string | null} */
let cookiesFile = null;

/**
 * Emulate yt-dlp saving its cookie jar on exit: append one rotated cookie, bump one expiry.
 * The contents are never printed.
 */
function writeBackCookies() {
  if (!cookiesFile) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const existing = existsSync(cookiesFile) ? readFileSync(cookiesFile, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) lines.push("# Netscape HTTP Cookie File");
  let bumped = false;
  let rotations = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const body = line.startsWith("#HttpOnly_") ? line.slice("#HttpOnly_".length) : line;
    if (body.startsWith("#") || body.trim() === "") continue;
    const fields = line.split("\t");
    if (fields.length !== 7) continue;
    if (fields[5].startsWith("FAKE_ROTATED_")) rotations += 1;
    const expiry = Number.parseInt(fields[4], 10);
    if (!bumped && Number.isFinite(expiry) && expiry > 0) {
      fields[4] = String(expiry + 86400);
      lines[i] = fields.join("\t");
      bumped = true;
    }
  }
  const rotated = [
    ".youtube.com",
    "TRUE",
    "/",
    "TRUE",
    String(nowSec + 365 * 86400),
    `FAKE_ROTATED_${rotations + 1}`,
    randomBytes(12).toString("hex"),
  ].join("\t");
  lines.push(rotated);
  writeFileSync(cookiesFile, `${lines.join("\n")}\n`);
}

/** @param {string} path @returns {boolean} true when the jar looks like a Netscape file */
function cookieJarLooksValid(path) {
  if (!existsSync(path)) return true;
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return true;
  const rows = text.split(/\r?\n/);
  const first = rows.find((r) => r.trim() !== "") ?? "";
  if (/^#\s*(Netscape )?HTTP Cookie File/i.test(first)) return true;
  return rows.some((r) => r.split("\t").length === 7);
}

/** @param {string} id @param {Record<string, any>} cfg */
function failureFor(id, cfg) {
  const perId = cfg.ids?.[id];
  if (perId?.fail || perId?.error) {
    return perId.error ?? cfg.failMessage ?? "Sign in to confirm you're not a bot";
  }
  if (cfg.fail || (cfg.failIds ?? []).includes(id)) {
    return cfg.failMessage ?? "Sign in to confirm you're not a bot";
  }
  return null;
}

const SAFE_NAME = /[\\/:*?"<>|]/g;

/**
 * Expand an output template for one video.
 * @param {string} template
 * @param {Record<string, any>} info
 * @param {Record<string, any>} [extra]
 */
function expandTemplate(template, info, extra = {}) {
  return template.replace(
    /%\(([^)]*)\)([#0\- +]*\d*(?:\.\d+)?)([sdiB]|j)/g,
    (_m, key, _f, kind) => {
      if (key === "") return kind === "j" ? JSON.stringify(info) : "";
      const field = key.replace(/[>&|].*$/, "");
      const value = field in extra ? extra[field] : info[field];
      if (value === undefined || value === null) return "NA";
      return String(value).replace(SAFE_NAME, "_");
    },
  );
}

/**
 * Pick listed entries by `--playlist-items` / `--playlist-end`.
 * @param {any[]} entries
 */
function selectEntries(entries) {
  let picked = entries;
  const items = last("--playlist-items");
  if (items) {
    const keep = new Set();
    for (const part of items.split(",")) {
      const m = /^(\d*)[:-](\d*)$/.exec(part.trim());
      if (m) {
        const from = m[1] ? Number(m[1]) : 1;
        const to = m[2] ? Number(m[2]) : entries.length;
        for (let n = from; n <= Math.min(to, entries.length); n += 1) keep.add(n);
      } else if (/^\d+$/.test(part.trim())) {
        keep.add(Number(part.trim()));
      }
    }
    picked = entries.filter((_e, i) => keep.has(i + 1));
  }
  const end = last("--playlist-end");
  if (end && Number(end) > 0) picked = picked.slice(0, Number(end));
  return picked;
}

/** @param {string} target @param {Record<string, any>} cfg */
function buildListing(target, cfg) {
  const kind = /feed\/history|^:ythis/.test(target)
    ? "history"
    : /^:ytwatchlater|^:ytwl|[?&]list=WL(?![\w-])/.test(target)
      ? "watchlater"
      : "default";
  let doc;
  if (cfg.playlist) {
    doc = Array.isArray(cfg.playlist)
      ? flatPlaylist({ kind, target, entries: cfg.playlist })
      : cfg.playlist;
  } else if (cfg.playlistFile) {
    const parsed = JSON.parse(readFileSync(cfg.playlistFile, "utf8"));
    doc = Array.isArray(parsed) ? flatPlaylist({ kind, target, entries: parsed }) : parsed;
  } else {
    doc = flatPlaylist({ kind, target, entries: DEFAULT_PLAYLIST_IDS.map((id) => flatEntry(id)) });
  }
  const entries = selectEntries(doc.entries ?? []);
  return { ...doc, entries, playlist_count: entries.length };
}

/** The -o value that applies to the media file (not a typed sidecar template). */
function mediaOutputTemplate() {
  const typed =
    /^(subtitle|thumbnail|description|annotation|infojson|link|pl_thumbnail|pl_description|pl_infojson|chapter):/;
  const values = (flags.get("--output") ?? [])
    .map((v) => v.replace(/^default:/, ""))
    .filter((v) => !typed.test(v));
  return values.at(-1) ?? "%(title)s [%(id)s].%(ext)s";
}

/** @param {string} line */
const out = (line) => process.stdout.write(`${line}\n`);
/** @param {string} line */
const err = (line) => process.stderr.write(`${line}\n`);

async function main() {
  if (has("--version")) {
    out(FAKE_YTDLP_VERSION);
    return 0;
  }
  if (has("--help")) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const cfg = loadConfig("YTDLP", SPEC);
  if (cfg.stderr) err(String(cfg.stderr));

  cookiesFile = last("--cookies") ?? null;
  if (cookiesFile && !cookieJarLooksValid(cookiesFile)) {
    err(`ERROR: '${cookiesFile}' does not look like a Netscape format cookies file`);
    cookiesFile = null;
    return cfg.failExit ?? 1;
  }

  if (positionals.length === 0) {
    err("yt-dlp: error: You must provide at least one URL.");
    err("Type yt-dlp --help to see a list of all options.");
    return 2;
  }

  const dumping = has("--dump-single-json") || has("--dump-json");
  const targets = positionals;

  if (dumping) {
    let exit = 0;
    for (const target of targets) {
      const id = extractVideoId(target);
      if (!id) {
        if (cfg.fail) {
          err(
            `ERROR: [youtube:tab] ${target}: ${cfg.failMessage ?? "Sign in to confirm you're not a bot"}`,
          );
          exit = cfg.failExit ?? 1;
          continue;
        }
        out(JSON.stringify(buildListing(target, cfg)));
        continue;
      }
      const message = failureFor(id, cfg);
      if (message) {
        err(`ERROR: [youtube] ${id}: ${message}`);
        exit = cfg.failExit ?? 1;
        continue;
      }
      out(JSON.stringify(buildInfo(id, { vcodec: cfg.vcodec, overrides: cfg.ids?.[id]?.info })));
    }
    return exit;
  }

  // Download invocation: expand every target to video ids.
  /** @type {{ id: string, url: string }[]} */
  const videos = [];
  for (const target of targets) {
    const id = extractVideoId(target);
    if (id) {
      videos.push({ id, url: target });
    } else {
      if (cfg.fail) {
        err(
          `ERROR: [youtube:tab] ${target}: ${cfg.failMessage ?? "Sign in to confirm you're not a bot"}`,
        );
        return cfg.failExit ?? 1;
      }
      for (const entry of buildListing(target, cfg).entries) {
        videos.push({
          id: entry.id,
          url: entry.url ?? `https://www.youtube.com/watch?v=${entry.id}`,
        });
      }
    }
  }

  let exit = 0;
  for (const video of videos) {
    const code = await downloadOne(video, cfg);
    if (code !== 0) exit = code;
  }
  return exit;
}

/**
 * @param {{ id: string, url: string }} video
 * @param {Record<string, any>} cfg
 */
async function downloadOne(video, cfg) {
  const { id, url } = video;
  const perId = cfg.ids?.[id] ?? {};
  const quiet = has("--quiet") || has("--no-progress");
  const log = (line) => {
    if (!quiet) out(line);
  };
  const delayMs = perId.delayMs ?? cfg.delayMs ?? 0;

  log(`[youtube] Extracting URL: ${url}`);
  log(`[youtube] ${id}: Downloading webpage`);
  log(`[youtube] ${id}: Downloading android vr player API JSON`);

  const message = failureFor(id, cfg);
  if (message) {
    err(`ERROR: [youtube] ${id}: ${message}`);
    return cfg.failExit ?? 1;
  }

  const family = normaliseVcodec(perId.vcodec ?? cfg.vcodec);
  const format = last("--format") ?? "";
  const formatIsAudio = /^(ba|bestaudio)(\/|$|\[)/.test(format);
  const audioOnly = has("--extract-audio") || formatIsAudio;
  const heightCap = /height<=?(\d+)/.exec(format);
  const height = heightCap ? Math.min(Number(heightCap[1]), 1080) : 1080;
  const mergeFormat = last("--merge-output-format") ?? last("--remux-video");
  let ext;
  if (audioOnly) {
    ext = has("--extract-audio") ? (last("--audio-format") ?? "opus") : "webm";
    if (ext === "best") ext = "opus";
  } else {
    ext = mergeFormat && mergeFormat !== "" ? mergeFormat : extForVcodec(family);
  }

  const meta = videoMeta(id);
  const homePath = (last("--paths") ?? "").replace(/^(home|temp):/, "");
  const template = mediaOutputTemplate();
  const target = join(
    homePath,
    expandTemplate(template, buildInfo(id, { vcodec: family }), { ext }),
  );
  const base = target.replace(/\.[^./\\]+$/, "");
  mkdirSync(dirname(target), { recursive: true });

  const bytes = perId.bytes ?? cfg.bytes ?? 65536;
  const info = buildInfo(id, {
    vcodec: family,
    ext,
    height,
    audioOnly,
    filesize: bytes,
    filename: target,
    overrides: perId.info,
  });

  log(`[info] ${id}: Downloading 1 format(s): ${info.format_id}`);
  const skipDownload = has("--skip-download") || has("--simulate");

  if (has("--write-info-json") && !has("--simulate")) {
    log(`[info] Writing video metadata as JSON to: ${base}.info.json`);
    writeFileSync(`${base}.info.json`, JSON.stringify(info));
  }

  const wantSubs = has("--write-subs") || has("--write-auto-subs");
  if (wantSubs && !has("--simulate")) {
    const langSpec = last("--sub-langs") ?? "en";
    const langs = langSpec
      .split(",")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("-"));
    const expanded = langs.some((l) => l === "all" || /[*.]/.test(l)) ? ["en", "es"] : langs;
    for (const lang of expanded) {
      const path = `${base}.${lang}.vtt`;
      log(`[info] Writing video subtitles to: ${path}`);
      const cue = `WEBVTT\nKind: captions\nLanguage: ${lang}\n\n00:00:00.000 --> 00:00:02.000\nFake caption for ${id}\n\n00:00:02.000 --> 00:00:04.000\nSecond fake cue for ${meta.title}\n`;
      writeFileSync(path, cue);
    }
  }

  if ((has("--write-thumbnail") || has("--write-all-thumbnails")) && !has("--simulate")) {
    const writeThumb = (path, seed) => {
      const body = createHash("sha256").update(seed).digest();
      const jpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
        body,
        Buffer.from([0xff, 0xd9]),
      ]);
      log(`[info] Writing video thumbnail to: ${path}`);
      writeFileSync(path, jpeg);
    };
    writeThumb(`${base}.jpg`, `${id}:maxresdefault`);
    if (has("--write-all-thumbnails")) {
      for (const variant of thumbnailVariants(id)) {
        const name =
          variant.url
            .split("/")
            .pop()
            ?.replace(/\.jpg$/, "") ?? variant.id;
        writeThumb(`${base}.${name}.jpg`, `${id}:${name}`);
      }
    }
  }

  if (!skipDownload) {
    if (has("--no-overwrites") && existsSync(target)) {
      log(`[download] ${target} has already been downloaded`);
    } else {
      log(`[download] Destination: ${target}`);
      const total = formatBytes(bytes);
      const steps = [0, 25, 50, 75, 100];
      for (const pct of steps) {
        if (pct === 0) {
          log(`[download]   0.0% of ${total.padStart(10)} at  Unknown B/s ETA Unknown`);
        } else if (pct < 100) {
          log(
            `[download]  ${pct.toFixed(1).padStart(5)}% of ${total.padStart(10)} at    2.00MiB/s ETA 00:0${4 - pct / 25}`,
          );
        } else {
          log(`[download] 100% of ${total.padStart(10)} in 00:00:00 at 2.00MiB/s`);
        }
        if (delayMs > 0) await sleep(delayMs / steps.length);
      }
      writeRandomFile(target, bytes);
    }
  } else if (delayMs > 0) {
    await sleep(delayMs);
  }

  for (const template2 of flags.get("--print") ?? []) {
    const stripped = template2.replace(/^[a-z_]+:/, "");
    if (stripped === "%()j") out(JSON.stringify(info));
    else out(expandTemplate(stripped, info, { filepath: target }));
  }
  if (has("--print-json")) out(JSON.stringify(info));
  return 0;
}

try {
  process.exitCode = await main();
} finally {
  if (!has("--version") && !has("--help")) writeBackCookies();
}
