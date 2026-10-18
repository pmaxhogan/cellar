import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSettings, type ResolvedSettings } from "@cellar/shared";
import {
  createRunTool,
  FFMPEG_ASSET,
  FFMPEG_RELEASE_API,
  FFMPEG_SUMS_ASSET,
  runFile,
  YTDLP_ASSET,
  YTDLP_RELEASE_API,
  YTDLP_SUMS_ASSET,
  type RunFile,
  type RunTool,
} from "../src/media/tools.ts";

/**
 * Fakes for the tool updater and the self-check: a routed fetch standing in
 * for GitHub and the internet, tiny node scripts standing in for downloaded
 * binaries, and a runTool wired to the scripts/fake-bin shims.
 */

export const fakeBinDir = fileURLToPath(new URL("../../scripts/fake-bin/", import.meta.url));
export const isWindows = process.platform === "win32";
/** bsdtar ships with Windows; CI runs GNU tar from PATH. */
export const TAR = isWindows ? "C:\\Windows\\System32\\tar.exe" : "tar";

export type Route = (init?: RequestInit) => Response | Promise<Response>;

export interface RoutedFetch {
  fetch: typeof fetch;
  calls: string[];
  routes: Map<string, Route>;
}

export function networkError(host: string): TypeError {
  return new TypeError("fetch failed", { cause: new Error(`getaddrinfo ENOTFOUND ${host}`) });
}

/** A fetch that serves only the routes it was given; anything else fails like DNS would. */
export function routedFetch(routes: Record<string, Route> = {}): RoutedFetch {
  const table = new Map(Object.entries(routes));
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const route = table.get(url);
    if (route === undefined) {
      throw networkError(new URL(url).host);
    }
    return route(init);
  };
  return { fetch: fetchImpl as typeof fetch, calls, routes: table };
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const bytes = (data: Buffer | string, status = 200): Response =>
  new Response(typeof data === "string" ? data : new Uint8Array(data), { status });

export const sha256 = (data: Buffer | string): string =>
  createHash("sha256").update(data).digest("hex");

/** A "binary" that node runs: prints a version for the version flag. */
export function versionScript(line: string): string {
  return `process.stdout.write(${JSON.stringify(`${line}\n`)});\n`;
}

/** Runs staged scripts with node; tar runs for real. */
export const scriptRunFile: RunFile = (file, args, timeoutMs) =>
  file === TAR
    ? runFile(file, args, timeoutMs)
    : runFile(process.execPath, [file, ...args], timeoutMs);

export const DL = "https://github.test/download";

export interface FakeRelease {
  ytdlpTag?: string;
  ytdlpBinary?: string;
  ytdlpSums?: string;
  ffmpegUpdatedAt?: string;
  ffmpegArchive?: Buffer;
  ffmpegSums?: string;
}

/** GitHub release API and asset downloads for both tools. */
export function githubRoutes(release: FakeRelease): Record<string, Route> {
  const routes: Record<string, Route> = {};
  if (release.ytdlpTag !== undefined) {
    const binary = release.ytdlpBinary ?? versionScript(release.ytdlpTag);
    const sums =
      release.ytdlpSums ?? `${sha256("other")}  yt-dlp.exe\n${sha256(binary)}  ${YTDLP_ASSET}\n`;
    routes[YTDLP_RELEASE_API] = () =>
      json({
        tag_name: release.ytdlpTag,
        assets: [
          { name: YTDLP_ASSET, browser_download_url: `${DL}/${YTDLP_ASSET}` },
          { name: YTDLP_SUMS_ASSET, browser_download_url: `${DL}/${YTDLP_SUMS_ASSET}` },
        ],
      });
    routes[`${DL}/${YTDLP_ASSET}`] = () => bytes(binary);
    routes[`${DL}/${YTDLP_SUMS_ASSET}`] = () => bytes(sums);
  }
  if (release.ffmpegArchive !== undefined) {
    const archive = release.ffmpegArchive;
    const sums = release.ffmpegSums ?? `${sha256(archive)}  ${FFMPEG_ASSET}\n`;
    routes[FFMPEG_RELEASE_API] = () =>
      json({
        tag_name: "latest",
        assets: [
          {
            name: FFMPEG_ASSET,
            browser_download_url: `${DL}/${FFMPEG_ASSET}`,
            ...(release.ffmpegUpdatedAt === undefined
              ? {}
              : { updated_at: release.ffmpegUpdatedAt }),
          },
          { name: FFMPEG_SUMS_ASSET, browser_download_url: `${DL}/${FFMPEG_SUMS_ASSET}` },
        ],
      });
    routes[`${DL}/${FFMPEG_ASSET}`] = () => bytes(archive);
    routes[`${DL}/${FFMPEG_SUMS_ASSET}`] = () => bytes(sums);
  }
  return routes;
}

/** Build an ffmpeg-master-latest-linux64-gpl.tar.xz holding version scripts. */
export async function buildFfmpegArchive(workDir: string, version: string): Promise<Buffer> {
  const root = join(workDir, "ffmpeg-master-latest-linux64-gpl");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "ffmpeg"), versionScript(`ffmpeg version ${version} Copyright`));
  writeFileSync(
    join(root, "bin", "ffprobe"),
    versionScript(`ffprobe version ${version} Copyright`),
  );
  writeFileSync(join(root, "README.txt"), "not extracted\n");
  const archive = join(workDir, "build.tar.xz");
  const result = await runFile(
    TAR,
    ["-cJf", archive, "-C", workDir, "ffmpeg-master-latest-linux64-gpl"],
    60_000,
  );
  if (result.code !== 0) {
    throw new Error(`tar failed: ${result.stderr}`);
  }
  return readFileSync(archive);
}

/** process.env without FAKE_* leaking in from the developer's shell. */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("FAKE_") && !key.startsWith("CELLAR_TOOL_")) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

/** runTool running the scripts/fake-bin shims through node. */
export function fakeRunTool(binDir: string, extra: Record<string, string> = {}): RunTool {
  const shim = (tool: string): string =>
    JSON.stringify([process.execPath, join(fakeBinDir, `${tool}.mjs`)]);
  return createRunTool({
    binDir,
    env: cleanEnv({
      CELLAR_TOOL_YT_DLP: shim("yt-dlp"),
      CELLAR_TOOL_FFMPEG: shim("ffmpeg"),
      CELLAR_TOOL_FFPROBE: shim("ffprobe"),
      FAKE_FFPROBE_DURATION: "1",
      ...extra,
    }),
  });
}

export function settingsWith(overrides: Partial<ResolvedSettings> = {}): ResolvedSettings {
  return { ...defaultSettings(), ...overrides };
}
