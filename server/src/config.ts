import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Every environment variable Cellar reads, validated once at boot. Nothing else
 * in the codebase touches process.env. Anything that is not deployment
 * fundamental belongs in the settings registry, not here.
 */

/**
 * `.env` files ship keys with blank values (`CF_ACCESS_AUD=`). A blank value
 * means "not set", so it is mapped to undefined before validation; otherwise a
 * blank optional key fails as "too small" instead of with the actionable
 * message the cross-field checks below produce.
 */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(blankToUndefined, z.string().min(1).optional());

const csvEmails = z
  .string()
  .transform((raw) =>
    raw
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part !== ""),
  )
  .pipe(z.array(z.string().min(3)));

const booleanFlag = z
  .string()
  .transform((raw) => raw.trim().toLowerCase())
  .pipe(z.enum(["1", "0", "true", "false", "yes", "no", ""]))
  .transform((raw) => raw === "1" || raw === "true" || raw === "yes");

const httpUrl = z.url({ protocol: /^https?$/ });

/**
 * A tool command override: a JSON array `["<command>", ...prefixArgs]`, so a
 * test can point yt-dlp at `node scripts/fake-bin/yt-dlp.mjs`. The value is
 * never echoed in a validation message.
 */
const toolOverride = z.preprocess(
  blankToUndefined,
  z
    .string()
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "Must be a JSON array of strings" });
        return z.NEVER;
      }
    })
    .pipe(z.array(z.string().min(1)).min(1, "Must name at least the command"))
    .optional(),
);

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  DATA_DIR: z.string().min(1).default("/data"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Used for OAuth redirects and share URLs. Deployments must set this. */
  PUBLIC_ORIGIN: httpUrl.default("http://localhost:8080"),
  /** 64 hex chars: the AES-256-GCM key for stored account secrets. */
  CELLAR_SECRET_KEY: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "CELLAR_SECRET_KEY must be 64 hex characters")
      .optional(),
  ),
  CF_ACCESS_TEAM_DOMAIN: optionalString,
  CF_ACCESS_AUD: optionalString,
  CF_ACCESS_ALLOWED_EMAILS: z.preprocess(blankToUndefined, csvEmails.optional()),
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  /** bgutil-ytdlp-pot-provider sidecar (HTTP server, port 4416 by default). */
  POT_PROVIDER_URL: z.preprocess(blankToUndefined, httpUrl.default("http://bgutil:4416")),
  INSECURE_ALLOW_PUBLIC_ACCESS: booleanFlag.default(false),
  /**
   * Where the built single page app lives. Defaults to web/dist resolved
   * against this module, which is correct both in the image (/app/server/dist
   * next to /app/web/dist) and when running from the repo.
   */
  WEB_DIST_DIR: optionalString,
  /** Baseline yt-dlp/ffmpeg/ffprobe baked into the image, copied to $DATA_DIR/bin. */
  BASELINE_BIN_DIR: z.preprocess(blankToUndefined, z.string().min(1).default("/opt/cellar/bin")),
  /** Test and dev seams: `["<command>", ...prefixArgs]` as JSON. Unset in deployments. */
  CELLAR_TOOL_YT_DLP: toolOverride,
  CELLAR_TOOL_FFMPEG: toolOverride,
  CELLAR_TOOL_FFPROBE: toolOverride,
  /** Passed to yt-dlp as --plugin-dirs (the bgutil PO token plugin). Empty disables. */
  CELLAR_YTDLP_PLUGIN_DIRS: z.string().default("/opt/cellar/yt-dlp-plugins"),
});

export type Env = z.infer<typeof envSchema>;

/** The external tools the server runs. */
export type ToolName = "yt-dlp" | "ffmpeg" | "ffprobe";

/** How to start a tool: the executable plus arguments that go before the real argv. */
export interface ToolCommand {
  command: string;
  prefixArgs: string[];
}

export interface Config {
  nodeEnv: Env["NODE_ENV"];
  port: number;
  /** Forced to 127.0.0.1 in insecure mode, whatever HOST said. */
  host: string;
  dataDir: string;
  /** cellar.db lives here. */
  stateDir: string;
  logsDir: string;
  /** Tool binaries the server runs (baseline copied in at boot, updates land here). */
  binDir: string;
  /** Per-video metadata: info json, captions, thumbnails. */
  metaDir: string;
  /** Scratch space; decrypted cookie jars land here, so it is 0700. */
  tmpDir: string;
  dbPath: string;
  secretKey: Buffer | null;
  logLevel: Env["LOG_LEVEL"];
  publicOrigin: string;
  potProviderUrl: string;
  google: { clientId: string; clientSecret: string | null } | null;
  /** Absolute path to the built SPA. The app serves it when it exists. */
  webDistDir: string;
  baselineBinDir: string;
  /** Per-tool command overrides from CELLAR_TOOL_<TOOL>; see toolCommand(). */
  toolOverrides: Partial<Record<ToolName, readonly string[]>>;
  /** yt-dlp --plugin-dirs value; empty string means none. */
  ytdlpPluginDirs: string;
  insecureMode: boolean;
  cfAccess: {
    teamDomain: string;
    aud: string;
    allowedEmails: readonly string[];
  } | null;
}

/**
 * Create the data directories at boot. state (the database, which holds
 * encrypted secrets) and tmp (where decrypted cookie jars are written) are
 * 0700, re-applied on every boot in case the host loosened them; the rest
 * keep the process umask.
 */
export function ensureDataDirs(
  config: Pick<Config, "dataDir" | "stateDir" | "logsDir" | "binDir" | "metaDir" | "tmpDir">,
): void {
  for (const dir of [config.dataDir, config.logsDir, config.binDir, config.metaDir]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const dir of [config.stateDir, config.tmpDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Parse and validate the environment. Throws ConfigError with an actionable
 * message rather than booting into a half-configured state.
 *
 * Security rule: Cellar refuses to start without Cloudflare Access configured
 * unless INSECURE_ALLOW_PUBLIC_ACCESS=1, in which case it binds loopback only.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Paths and messages only: zod issues never echo the rejected value here,
    // so a malformed secret cannot leak into the boot log.
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid environment:\n${details}`);
  }
  const env = parsed.data;

  const dataDir = resolve(env.DATA_DIR);
  const stateDir = resolve(dataDir, "state");

  const insecureMode = env.INSECURE_ALLOW_PUBLIC_ACCESS;
  const hasCfAccess =
    env.CF_ACCESS_TEAM_DOMAIN !== undefined &&
    env.CF_ACCESS_AUD !== undefined &&
    env.CF_ACCESS_ALLOWED_EMAILS !== undefined &&
    env.CF_ACCESS_ALLOWED_EMAILS.length > 0;

  if (!insecureMode && !hasCfAccess) {
    throw new ConfigError(
      "Cloudflare Access is not configured. Set CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD and " +
        "CF_ACCESS_ALLOWED_EMAILS, or set INSECURE_ALLOW_PUBLIC_ACCESS=1 to run without " +
        "authentication bound to 127.0.0.1 only.",
    );
  }

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    // Insecure mode is loopback only, no matter what HOST says.
    host: insecureMode ? "127.0.0.1" : env.HOST,
    dataDir,
    stateDir,
    logsDir: resolve(dataDir, "logs"),
    binDir: resolve(dataDir, "bin"),
    metaDir: resolve(dataDir, "meta"),
    tmpDir: resolve(dataDir, "tmp"),
    dbPath: resolve(stateDir, "cellar.db"),
    secretKey:
      env.CELLAR_SECRET_KEY === undefined ? null : Buffer.from(env.CELLAR_SECRET_KEY, "hex"),
    logLevel: env.LOG_LEVEL,
    publicOrigin: env.PUBLIC_ORIGIN.replace(/\/+$/, ""),
    potProviderUrl: env.POT_PROVIDER_URL.replace(/\/+$/, ""),
    google:
      env.GOOGLE_CLIENT_ID === undefined
        ? null
        : { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET ?? null },
    webDistDir: resolve(
      env.WEB_DIST_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
    ),
    baselineBinDir: resolve(env.BASELINE_BIN_DIR),
    toolOverrides: {
      ...(env.CELLAR_TOOL_YT_DLP === undefined ? {} : { "yt-dlp": env.CELLAR_TOOL_YT_DLP }),
      ...(env.CELLAR_TOOL_FFMPEG === undefined ? {} : { ffmpeg: env.CELLAR_TOOL_FFMPEG }),
      ...(env.CELLAR_TOOL_FFPROBE === undefined ? {} : { ffprobe: env.CELLAR_TOOL_FFPROBE }),
    },
    ytdlpPluginDirs: env.CELLAR_YTDLP_PLUGIN_DIRS.trim(),
    insecureMode,
    cfAccess:
      insecureMode || !hasCfAccess
        ? null
        : {
            teamDomain: env.CF_ACCESS_TEAM_DOMAIN as string,
            aud: env.CF_ACCESS_AUD as string,
            allowedEmails: env.CF_ACCESS_ALLOWED_EMAILS as string[],
          },
  };
}

/**
 * Resolve how to run a tool: the CELLAR_TOOL_<TOOL> override when set, else
 * `$DATA_DIR/bin/<tool>` when it exists at call time (the updater may install
 * it after boot), else the bare name so the OS searches PATH.
 */
export function toolCommand(
  config: Pick<Config, "toolOverrides" | "binDir">,
  tool: ToolName,
): ToolCommand {
  const override = config.toolOverrides[tool];
  if (override !== undefined && override.length > 0) {
    const [command, ...prefixArgs] = override as [string, ...string[]];
    return { command, prefixArgs };
  }
  const installed = join(config.binDir, tool);
  return { command: existsSync(installed) ? installed : tool, prefixArgs: [] };
}
