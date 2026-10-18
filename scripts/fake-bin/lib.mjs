// Shared helpers for the cellar fake-bin shims (yt-dlp, ffmpeg, ffprobe).
// Plain Node ESM with no dependencies, so the shims run on Linux CI and on Windows.
import { appendFileSync, closeSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * Coerce an env string to the declared type. Booleans accept 1/true/yes/on.
 * @param {string} raw
 * @param {"bool" | "int" | "num" | "str" | "list"} type
 */
export function coerce(raw, type) {
  switch (type) {
    case "bool":
      return /^(1|true|yes|on)$/i.test(raw.trim());
    case "int":
      return Number.parseInt(raw, 10);
    case "num":
      return Number.parseFloat(raw);
    case "list":
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    default:
      return raw;
  }
}

/**
 * Parse a scenario value: inline JSON (starts with "{" or "[") or a path to a JSON file.
 * @param {string} raw
 */
export function parseScenarioValue(raw) {
  const text = raw.trim();
  if (text === "") return {};
  if (text.startsWith("{") || text.startsWith("[")) return JSON.parse(text);
  return JSON.parse(readFileSync(text, "utf8"));
}

/**
 * Atomically allocate the next 0-based call index by appending one byte to a state file.
 * @param {string | undefined} statePath
 */
export function nextCallIndex(statePath) {
  if (!statePath) return 0;
  appendFileSync(statePath, "x");
  return statSync(statePath).size - 1;
}

/**
 * Resolve the effective config of one substantive invocation.
 *
 * Order of precedence (later wins): env vars from `spec`, the scenario object
 * (`FAKE_<TOOL>_SCENARIO`, inline JSON or a file path), then the `calls[i]` entry of the
 * scenario, where `i` is this invocation's index in `FAKE_<TOOL>_STATE` (the last entry
 * repeats once the list is exhausted).
 *
 * @param {string} tool upper-case tool prefix, for example "YTDLP"
 * @param {Record<string, { env: string, type: "bool" | "int" | "num" | "str" | "list" }>} spec
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, any>}
 */
export function loadConfig(tool, spec, env = process.env) {
  /** @type {Record<string, any>} */
  const cfg = {};
  for (const [key, def] of Object.entries(spec)) {
    const raw = env[`FAKE_${tool}_${def.env}`];
    if (raw !== undefined && raw !== "") cfg[key] = coerce(raw, def.type);
  }
  const scenarioRaw = env[`FAKE_${tool}_SCENARIO`];
  if (scenarioRaw) {
    const { calls, ...base } = parseScenarioValue(scenarioRaw);
    Object.assign(cfg, base);
    if (Array.isArray(calls) && calls.length > 0) {
      const index = nextCallIndex(env[`FAKE_${tool}_STATE`]);
      Object.assign(cfg, calls[Math.min(index, calls.length - 1)] ?? {});
    }
  }
  return cfg;
}

/**
 * Append the argv (without node and script path) as one JSON line.
 * @param {string | undefined} file
 * @param {string[]} argv
 */
export function recordArgv(file, argv) {
  if (!file) return;
  appendFileSync(file, `${JSON.stringify(argv)}\n`);
}

/**
 * Write `size` random bytes to `path` in 1 MiB chunks (so large sizes stay cheap).
 * @param {string} path
 * @param {number} size
 */
export function writeRandomFile(path, size) {
  const fd = openSync(path, "w");
  try {
    let left = size;
    while (left > 0) {
      const n = Math.min(left, 1024 * 1024);
      writeSync(fd, randomBytes(n));
      left -= n;
    }
  } finally {
    closeSync(fd);
  }
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * yt-dlp style binary size, for example 64.00KiB.
 * @param {number} n
 */
export function formatBytes(n) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 2)}${units[i]}`;
}

/**
 * HH:MM:SS.cc style timestamp used by ffmpeg progress lines.
 * @param {number} seconds
 * @param {number} [decimals]
 */
export function formatClock(seconds, decimals = 2) {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total - h * 3600 - m * 60;
  const pad = (v, w) => String(v).padStart(w, "0");
  const secs = s.toFixed(decimals);
  return `${pad(h, 2)}:${pad(m, 2)}:${secs.padStart(decimals + 3, "0")}`;
}

/**
 * Last path segment, accepting both separators (the shims run on Windows too).
 * @param {string} p
 */
export function baseName(p) {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}
