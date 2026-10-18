import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsRegistry } from "@cellar/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setKv } from "../src/db/kv.ts";
import { DomainError } from "../src/domain/errors.ts";
import { createConsoleLogger } from "../src/logging.ts";
import {
  buildToolsResponse,
  checkToolUpdates,
  createRunTool,
  describeError,
  FFMPEG_ASSET,
  FFMPEG_RELEASE_API,
  FFMPEG_SUMS_ASSET,
  ffmpegReleaseApi,
  NVENC_BLOCKED_ERROR,
  nvencTestEncodeArgs,
  parseChecksum,
  probeNvenc,
  readToolState,
  readToolVersions,
  recordBaselineVersions,
  resolvePotProviderUrl,
  resolveToolCommand,
  rollbackTool,
  runFile,
  selectFfmpegAsset,
  startToolUpdateSchedule,
  TOOL_VERSIONS_KEY,
  toolEnvKey,
  toolVersionsInfo,
  updateToolState,
  YTDLP_ASSET,
  YTDLP_RELEASE_API,
  type ToolUpdateDeps,
} from "../src/media/tools.ts";
import { createTempDb, type TempDb } from "./helpers.ts";
import {
  buildFfmpegArchive,
  bytes,
  DL,
  fakeBinDir,
  githubRoutes,
  json,
  nvencFfmpegScript,
  routedFetch,
  scriptRunFile,
  serveRoutes,
  settingsWith,
  TAR,
  versionScript,
  type RoutedFetch,
} from "./systemHelpers.ts";

const log = createConsoleLogger("silent");

let dir: string;
let binDir: string;
let temp: TempDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cellar-updates-"));
  binDir = join(dir, "bin");
  mkdirSync(binDir);
  temp = createTempDb();
});

afterEach(() => {
  temp.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeDeps(
  github: RoutedFetch,
  overrides: Partial<ToolUpdateDeps> & { autoUpdate?: boolean; ffmpegTag?: string } = {},
): ToolUpdateDeps {
  const { autoUpdate = true, ffmpegTag = "latest", ...rest } = overrides;
  return {
    db: temp.db,
    log,
    config: { binDir },
    fetch: github.fetch,
    runFile: scriptRunFile,
    getSettings: () =>
      settingsWith({ "tools.auto_update": autoUpdate, "tools.ffmpeg_release_tag": ffmpegTag }),
    now: () => 1_000,
    tarCommand: TAR,
    ...rest,
  };
}

const read = (name: string): string => readFileSync(join(binDir, name), "utf8");

function installYtdlp(version: string): void {
  writeFileSync(join(binDir, "yt-dlp"), versionScript(version));
  updateToolState(temp.db, (state) => {
    state.ytdlp.current = version;
  });
}

describe("checkToolUpdates: yt-dlp", () => {
  it("downloads, verifies and swaps atomically, keeping the old binary as .prev", async () => {
    installYtdlp("2026.08.19");
    const github = routedFetch(githubRoutes({ ytdlpTag: "2026.09.01" }));
    const outcomes = await checkToolUpdates(makeDeps(github), { tool: "ytdlp" });

    expect(outcomes).toEqual([
      {
        tool: "ytdlp",
        status: "updated",
        detail: "yt-dlp updated from 2026.08.19 to 2026.09.01.",
      },
    ]);
    expect(read("yt-dlp")).toBe(versionScript("2026.09.01"));
    expect(read("yt-dlp.prev")).toBe(versionScript("2026.08.19"));
    expect(existsSync(join(binDir, ".staging"))).toBe(false);

    const state = readToolState(temp.db);
    expect(state.ytdlp).toMatchObject({
      current: "2026.09.01",
      previous: "2026.08.19",
      latest: "2026.09.01",
      checked_at: 1_000,
      updated_at: 1_000,
      last_error: null,
      rolled_back_from: null,
    });
    expect(toolVersionsInfo(state, "ytdlp").update_available).toBe(false);
    expect(readToolVersions(temp.db).ytdlp).toBe("2026.09.01");
    expect(github.calls).toEqual([YTDLP_RELEASE_API, `${DL}/SHA2-256SUMS`, `${DL}/${YTDLP_ASSET}`]);

    // Already current: one metadata call, no download.
    const again = await checkToolUpdates(makeDeps(github), { tool: "ytdlp" });
    expect(again[0]?.status).toBe("up_to_date");
    expect(github.calls).toHaveLength(4);
  });

  it("installs into an empty bin dir without a .prev", async () => {
    const github = routedFetch(githubRoutes({ ytdlpTag: "2026.09.01" }));
    const [outcome] = await checkToolUpdates(makeDeps(github), { tool: "ytdlp" });
    expect(outcome?.status).toBe("updated");
    expect(outcome?.detail).toContain("from unknown");
    expect(existsSync(join(binDir, "yt-dlp.prev"))).toBe(false);
  });

  it("rejects a checksum mismatch and leaves the installed binary alone", async () => {
    installYtdlp("2026.08.19");
    const github = routedFetch(
      githubRoutes({ ytdlpTag: "2026.09.01", ytdlpSums: `${"0".repeat(64)}  ${YTDLP_ASSET}\n` }),
    );
    const [outcome] = await checkToolUpdates(makeDeps(github), { tool: "ytdlp" });
    expect(outcome?.status).toBe("failed");
    expect(outcome?.detail).toMatch(/checksum mismatch/);
    expect(read("yt-dlp")).toBe(versionScript("2026.08.19"));
    expect(existsSync(join(binDir, "yt-dlp.prev"))).toBe(false);
    expect(existsSync(join(binDir, ".staging"))).toBe(false);
    const state = readToolState(temp.db);
    expect(state.ytdlp.last_error).toMatch(/checksum mismatch/);
    expect(state.ytdlp.latest).toBe("2026.09.01");
    expect(toolVersionsInfo(state, "ytdlp").update_available).toBe(true);
  });

  it("only checks when auto-update is off, even when forced", async () => {
    installYtdlp("2026.08.19");
    const github = routedFetch(githubRoutes({ ytdlpTag: "2026.09.01" }));
    const deps = makeDeps(github, { autoUpdate: false });
    const [outcome] = await checkToolUpdates(deps, { tool: "ytdlp" });
    expect(outcome).toMatchObject({ status: "available" });
    expect(outcome?.detail).toContain("auto-update is off");
    const [forced] = await checkToolUpdates(deps, { tool: "ytdlp", force: true });
    expect(forced?.status).toBe("available");
    expect(github.calls).toEqual([YTDLP_RELEASE_API, YTDLP_RELEASE_API]);
    expect(read("yt-dlp")).toBe(versionScript("2026.08.19"));
    expect(toolVersionsInfo(readToolState(temp.db), "ytdlp").update_available).toBe(true);
  });

  it("refuses a download that does not run", async () => {
    installYtdlp("2026.08.19");
    const github = routedFetch(
      githubRoutes({ ytdlpTag: "2026.09.01", ytdlpBinary: "process.exit(3);\n" }),
    );
    const [outcome] = await checkToolUpdates(makeDeps(github), { tool: "ytdlp" });
    expect(outcome?.status).toBe("failed");
    expect(outcome?.detail).toMatch(/did not run \(exit 3\)/);
    expect(read("yt-dlp")).toBe(versionScript("2026.08.19"));
  });

  it("rolls back, does not reinstall the rolled back release, and force does", async () => {
    installYtdlp("2026.08.19");
    const github = routedFetch(githubRoutes({ ytdlpTag: "2026.09.01" }));
    const deps = makeDeps(github);
    await checkToolUpdates(deps, { tool: "ytdlp" });

    const info = await rollbackTool(deps, "ytdlp");
    expect(info).toMatchObject({
      current: "2026.08.19",
      previous: "2026.09.01",
      rolled_back_from: "2026.09.01",
      update_available: false,
    });
    expect(read("yt-dlp")).toBe(versionScript("2026.08.19"));
    expect(read("yt-dlp.prev")).toBe(versionScript("2026.09.01"));

    const [skipped] = await checkToolUpdates(deps, { tool: "ytdlp" });
    expect(skipped?.status).toBe("skipped");
    expect(read("yt-dlp")).toBe(versionScript("2026.08.19"));

    const [forced] = await checkToolUpdates(deps, { tool: "ytdlp", force: true });
    expect(forced?.status).toBe("updated");
    expect(read("yt-dlp")).toBe(versionScript("2026.09.01"));
    expect(readToolState(temp.db).ytdlp.rolled_back_from).toBeNull();

    // Rolling back twice returns to where it started.
    await rollbackTool(deps, "ytdlp");
    await rollbackTool(deps, "ytdlp");
    expect(read("yt-dlp")).toBe(versionScript("2026.09.01"));
  });

  it("keeps the recorded version when the rolled back binary does not run", async () => {
    writeFileSync(join(binDir, "yt-dlp"), "process.exit(1);\n");
    writeFileSync(join(binDir, "yt-dlp.prev"), "process.exit(1);\n");
    updateToolState(temp.db, (state) => {
      state.ytdlp.current = "new";
      state.ytdlp.previous = "old";
    });
    const info = await rollbackTool(makeDeps(routedFetch()), "ytdlp");
    expect(info).toMatchObject({ current: "old", previous: "new" });

    const throwing = makeDeps(routedFetch(), {
      runFile: () => Promise.reject(new Error("spawn ENOENT")),
    });
    expect(await rollbackTool(throwing, "ytdlp")).toMatchObject({ current: "new" });
  });

  it("refuses a rollback with no previous binary", async () => {
    installYtdlp("2026.08.19");
    const promise = rollbackTool(makeDeps(routedFetch()), "ytdlp");
    await expect(promise).rejects.toBeInstanceOf(DomainError);
    await expect(promise).rejects.toMatchObject({ status: 412 });
  });
});

describe("checkToolUpdates: ffmpeg", () => {
  it("unpacks ffmpeg and ffprobe with tar, verifies both and swaps them as a pair", async () => {
    writeFileSync(join(binDir, "ffmpeg"), versionScript("ffmpeg version 7.1 Copyright"));
    writeFileSync(join(binDir, "ffprobe"), versionScript("ffprobe version 7.1 Copyright"));
    updateToolState(temp.db, (state) => {
      state.ffmpeg.current = "7.1";
    });
    const archive = await buildFfmpegArchive(join(dir, "build"), "N-200-gnew");
    const github = routedFetch(
      githubRoutes({ ffmpegArchive: archive, ffmpegUpdatedAt: "2026-10-18T10:00:00Z" }),
    );
    const deps = makeDeps(github);

    const [outcome] = await checkToolUpdates(deps, { tool: "ffmpeg" });
    expect(outcome?.status).toBe("updated");
    expect(outcome?.detail).toContain("7.1 to N-200-gnew");
    expect(read("ffmpeg")).toContain("N-200-gnew");
    expect(read("ffprobe")).toContain("ffprobe version N-200-gnew");
    expect(read("ffmpeg.prev")).toContain("ffmpeg version 7.1");
    expect(read("ffprobe.prev")).toContain("ffprobe version 7.1");
    expect(existsSync(join(binDir, "README.txt"))).toBe(false);
    expect(existsSync(join(binDir, ".staging"))).toBe(false);

    let state = readToolState(temp.db);
    expect(state.ffmpeg).toMatchObject({
      current: "N-200-gnew",
      previous: "7.1",
      latest: "2026-10-18T10:00:00Z",
      asset_updated_at: "2026-10-18T10:00:00Z",
      previous_asset_updated_at: null,
    });
    expect(toolVersionsInfo(state, "ffmpeg")).toMatchObject({
      update_available: false,
      asset_updated_at: "2026-10-18T10:00:00Z",
    });

    // Same build asset: skipped on updated_at without downloading.
    const [again] = await checkToolUpdates(deps, { tool: "ffmpeg" });
    expect(again?.status).toBe("up_to_date");
    expect(github.calls.filter((url) => url.endsWith(FFMPEG_ASSET))).toHaveLength(1);

    const info = await rollbackTool(deps, "ffmpeg");
    expect(info).toMatchObject({
      current: "7.1",
      previous: "N-200-gnew",
      asset_updated_at: null,
      rolled_back_from: "2026-10-18T10:00:00Z",
      update_available: false,
    });
    expect(read("ffprobe")).toContain("ffprobe version 7.1");
    expect(read("ffprobe.prev")).toContain("N-200-gnew");
    const [skipped] = await checkToolUpdates(deps, { tool: "ffmpeg" });
    expect(skipped?.status).toBe("skipped");

    // A newer build is not the rolled back one, so it installs.
    serveRoutes(
      github,
      githubRoutes({ ffmpegArchive: archive, ffmpegUpdatedAt: "2026-10-19T10:00:00Z" }),
    );
    const [newer] = await checkToolUpdates(deps, { tool: "ffmpeg" });
    expect(newer?.status).toBe("updated");
    state = readToolState(temp.db);
    expect(state.ffmpeg.previous_asset_updated_at).toBeNull();
    expect(state.ffmpeg.rolled_back_from).toBeNull();
  });

  it("needs both .prev files to roll back", async () => {
    writeFileSync(join(binDir, "ffmpeg"), "x");
    writeFileSync(join(binDir, "ffmpeg.prev"), "x");
    writeFileSync(join(binDir, "ffprobe"), "x");
    await expect(rollbackTool(makeDeps(routedFetch()), "ffmpeg")).rejects.toMatchObject({
      code: "precondition_failed",
    });
  });

  it("fails cleanly when the archive does not unpack", async () => {
    const archive = Buffer.from("this is not an xz archive");
    const github = routedFetch(
      githubRoutes({ ffmpegArchive: archive, ffmpegUpdatedAt: "2026-10-18T10:00:00Z" }),
    );
    const [outcome] = await checkToolUpdates(makeDeps(github), { tool: "ffmpeg" });
    expect(outcome?.status).toBe("failed");
    expect(outcome?.detail).toMatch(/could not unpack/);
    expect(existsSync(join(binDir, ".staging"))).toBe(false);
  });

  it("fails when the build asset has no updated_at or no checksum line", async () => {
    const archive = Buffer.from("x");
    const noDate = routedFetch(githubRoutes({ ffmpegArchive: archive }));
    expect((await checkToolUpdates(makeDeps(noDate), { tool: "ffmpeg" }))[0]?.detail).toMatch(
      /no updated_at/,
    );
    const noSum = routedFetch(
      githubRoutes({ ffmpegArchive: archive, ffmpegUpdatedAt: "t", ffmpegSums: "nothing\n" }),
    );
    expect((await checkToolUpdates(makeDeps(noSum), { tool: "ffmpeg" }))[0]?.detail).toBe(
      `no checksum for ${FFMPEG_ASSET}`,
    );
    const wrongSum = routedFetch(
      githubRoutes({
        ffmpegArchive: archive,
        ffmpegUpdatedAt: "t",
        ffmpegSums: `${"f".repeat(64)}  ${FFMPEG_ASSET}\n`,
      }),
    );
    expect((await checkToolUpdates(makeDeps(wrongSum), { tool: "ffmpeg" }))[0]?.detail).toMatch(
      /^checksum mismatch/,
    );
    expect(existsSync(join(binDir, "ffmpeg"))).toBe(false);
  });

  it("checks for ffmpeg without installing when auto-update is off", async () => {
    const github = routedFetch(
      githubRoutes({ ffmpegArchive: Buffer.from("x"), ffmpegUpdatedAt: "2026-10-18T10:00:00Z" }),
    );
    const [outcome] = await checkToolUpdates(makeDeps(github, { autoUpdate: false }), {
      tool: "ffmpeg",
    });
    expect(outcome?.status).toBe("available");
    expect(github.calls).toEqual([FFMPEG_RELEASE_API]);
    const info = toolVersionsInfo(readToolState(temp.db), "ffmpeg");
    expect(info).toMatchObject({ latest: "2026-10-18T10:00:00Z", update_available: true });
  });
});

const PINNED_TAG = "autobuild-2025-12-31-14-28";
const PINNED_ASSET = "ffmpeg-N-122306-geea648ef1d-linux64-gpl.tar.xz";
const PINNED_ROOT = "ffmpeg-N-122306-geea648ef1d-linux64-gpl";
/** Assets a real dated release lists next to the one the updater wants. */
const DECOYS = [
  "ffmpeg-N-122306-geea648ef1d-linux64-gpl-shared.tar.xz",
  "ffmpeg-N-122306-geea648ef1d-linux64-lgpl.tar.xz",
  "ffmpeg-N-122306-geea648ef1d-linuxarm64-gpl.tar.xz",
  "ffmpeg-N-122306-geea648ef1d-win64-gpl.zip",
  "ffmpeg-n8.0-1-g0123456789-linux64-gpl-8.0.tar.xz",
];

describe("checkToolUpdates: ffmpeg release tag", () => {
  it("defaults to the pinned BtbN build that still encodes on older drivers", () => {
    expect(settingsWith()["tools.ffmpeg_release_tag"]).toBe(PINNED_TAG);
    expect(buildToolsResponse(temp.db, settingsWith(), "x").ffmpeg_release_tag).toBe(PINNED_TAG);
  });

  it("installs the dated linux64-gpl asset of a pinned tag, unpacking its own root", async () => {
    const archive = await buildFfmpegArchive(join(dir, "build"), "N-122306-geea648ef1d", {
      root: PINNED_ROOT,
    });
    const github = routedFetch(
      githubRoutes({
        ffmpegTag: PINNED_TAG,
        ffmpegAssetName: PINNED_ASSET,
        ffmpegOtherAssets: DECOYS,
        ffmpegArchive: archive,
        ffmpegUpdatedAt: "2025-12-31T14:40:00Z",
      }),
    );
    const [outcome] = await checkToolUpdates(makeDeps(github, { ffmpegTag: PINNED_TAG }), {
      tool: "ffmpeg",
    });
    expect(outcome?.status).toBe("updated");
    expect(github.calls).toEqual([
      `https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/${PINNED_TAG}`,
      `${DL}/${FFMPEG_SUMS_ASSET}`,
      `${DL}/${PINNED_ASSET}`,
    ]);
    expect(read("ffmpeg")).toContain("N-122306-geea648ef1d");
    expect(read("ffprobe")).toContain("ffprobe version N-122306-geea648ef1d");
    expect(readToolState(temp.db).ffmpeg).toMatchObject({
      current: "N-122306-geea648ef1d",
      latest: "2025-12-31T14:40:00Z",
      asset_updated_at: "2025-12-31T14:40:00Z",
    });
  });

  it("follows BtbN latest with the master asset when the tag is latest", async () => {
    const archive = await buildFfmpegArchive(join(dir, "build"), "N-300-glatest");
    const github = routedFetch(
      githubRoutes({
        ffmpegArchive: archive,
        ffmpegUpdatedAt: "2026-10-18T10:00:00Z",
        // A latest release also carries dated-looking names; only the master asset counts.
        ffmpegOtherAssets: DECOYS,
      }),
    );
    const [outcome] = await checkToolUpdates(makeDeps(github, { ffmpegTag: "latest" }), {
      tool: "ffmpeg",
    });
    expect(outcome?.status).toBe("updated");
    expect(github.calls[0]).toBe(FFMPEG_RELEASE_API);
    expect(github.calls).toContain(`${DL}/${FFMPEG_ASSET}`);
    expect(read("ffmpeg")).toContain("N-300-glatest");
  });

  it("selects exactly one asset or explains why not", () => {
    const release = (names: string[]) => ({
      tag_name: "t",
      assets: names.map((name) => ({ name, browser_download_url: `${DL}/${name}` })),
    });
    expect(selectFfmpegAsset(release([...DECOYS, PINNED_ASSET]), PINNED_TAG).name).toBe(
      PINNED_ASSET,
    );
    expect(selectFfmpegAsset(release([FFMPEG_ASSET, PINNED_ASSET]), "latest").name).toBe(
      FFMPEG_ASSET,
    );
    expect(() => selectFfmpegAsset(release(DECOYS), PINNED_TAG)).toThrow(
      /release t has no ffmpeg-N-\.\.\.-linux64-gpl\.tar\.xz asset/,
    );
    expect(() =>
      selectFfmpegAsset(release([PINNED_ASSET, "ffmpeg-N-1-gabc-linux64-gpl.tar.xz"]), PINNED_TAG),
    ).toThrow(/more than one/);
    expect(() => selectFfmpegAsset(release([PINNED_ASSET]), "latest")).toThrow(
      `release t has no ${FFMPEG_ASSET} asset`,
    );
    expect(ffmpegReleaseApi("a b")).toBe(
      "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/a%20b",
    );
  });

  it("only accepts tag-safe setting values", () => {
    const schema = settingsRegistry["tools.ffmpeg_release_tag"].schema;
    expect(schema.safeParse("latest").success).toBe(true);
    expect(schema.safeParse(PINNED_TAG).success).toBe(true);
    expect(schema.safeParse("../../evil").success).toBe(false);
    expect(schema.safeParse("a?b=c").success).toBe(false);
    expect(schema.safeParse("").success).toBe(false);
  });
});

describe("checkToolUpdates: NVENC guard", () => {
  /** Live ffmpeg + ffprobe whose NVENC test encode works. */
  function installLiveFfmpeg(version: string): void {
    writeFileSync(join(binDir, "ffmpeg"), nvencFfmpegScript(version, "works"));
    writeFileSync(join(binDir, "ffprobe"), versionScript(`ffprobe version ${version} Copyright`));
    updateToolState(temp.db, (state) => {
      state.ffmpeg.current = version;
      state.ffmpeg.asset_updated_at = "2025-12-31T14:40:00Z";
    });
  }

  async function stagedRelease(
    version: string,
    nvenc: "works" | "listed-but-fails",
    updatedAt: string,
  ) {
    const archive = await buildFfmpegArchive(join(dir, `build-${version}`), version, {
      ffmpegScript: nvencFfmpegScript(version, nvenc),
    });
    return githubRoutes({ ffmpegArchive: archive, ffmpegUpdatedAt: updatedAt });
  }

  it("probes NVENC with a listing and a real test encode per encoder", async () => {
    const works = join(dir, "works");
    const fails = join(dir, "fails");
    writeFileSync(works, nvencFfmpegScript("1", "works"));
    writeFileSync(fails, nvencFfmpegScript("2", "listed-but-fails"));
    writeFileSync(join(dir, "plain"), versionScript("ffmpeg version 3 Copyright"));
    expect(await probeNvenc(scriptRunFile, works)).toEqual({ hevc_nvenc: true, h264_nvenc: true });
    expect(await probeNvenc(scriptRunFile, fails)).toEqual({
      hevc_nvenc: false,
      h264_nvenc: false,
    });
    // No NVENC listed, or no binary at all.
    expect(await probeNvenc(scriptRunFile, join(dir, "plain"))).toEqual({
      hevc_nvenc: false,
      h264_nvenc: false,
    });
    expect(await probeNvenc(runFile, join(dir, "missing"))).toEqual({
      hevc_nvenc: false,
      h264_nvenc: false,
    });
    expect(nvencTestEncodeArgs("hevc_nvenc")).toEqual(
      expect.arrayContaining(["-c:v", "hevc_nvenc", "-f", "null", "-"]),
    );
  });

  it("refuses a build that loses NVENC, keeps the live one and does not retry it", async () => {
    installLiveFfmpeg("N-122306-gold");
    const github = routedFetch(
      await stagedRelease("N-200-gnewapi", "listed-but-fails", "2026-10-18T10:00:00Z"),
    );
    const deps = makeDeps(github);

    const [outcome] = await checkToolUpdates(deps, { tool: "ffmpeg" });
    expect(outcome).toEqual({
      tool: "ffmpeg",
      status: "blocked",
      detail: `${NVENC_BLOCKED_ERROR} (build 2026-10-18T10:00:00Z); force an update to try it again.`,
    });
    expect(read("ffmpeg")).toContain("N-122306-gold");
    expect(read("ffprobe")).toContain("ffprobe version N-122306-gold");
    expect(existsSync(join(binDir, "ffmpeg.prev"))).toBe(false);
    expect(existsSync(join(binDir, ".staging"))).toBe(false);
    let state = readToolState(temp.db);
    expect(state.ffmpeg).toMatchObject({
      current: "N-122306-gold",
      asset_updated_at: "2025-12-31T14:40:00Z",
      latest: "2026-10-18T10:00:00Z",
      last_error: NVENC_BLOCKED_ERROR,
      blocked_latest: "2026-10-18T10:00:00Z",
      checked_at: 1_000,
    });
    // The blocked build is not offered as an update.
    expect(toolVersionsInfo(state, "ffmpeg")).toMatchObject({
      update_available: false,
      last_error: NVENC_BLOCKED_ERROR,
    });

    // The daily check does not download it again, and the error stays.
    const downloads = () => github.calls.filter((url) => url === `${DL}/${FFMPEG_ASSET}`).length;
    expect(downloads()).toBe(1);
    const [again] = await checkToolUpdates(deps, { tool: "ffmpeg" });
    expect(again?.status).toBe("blocked");
    expect(downloads()).toBe(1);
    expect(readToolState(temp.db).ffmpeg.last_error).toBe(NVENC_BLOCKED_ERROR);

    // Forcing retries it (and the guard still holds).
    const [forced] = await checkToolUpdates(deps, { tool: "ffmpeg", force: true });
    expect(forced?.status).toBe("blocked");
    expect(downloads()).toBe(2);

    // A later build that keeps NVENC is swapped in and clears the block.
    serveRoutes(github, await stagedRelease("N-201-gfixed", "works", "2026-10-19T10:00:00Z"));
    const [fixed] = await checkToolUpdates(deps, { tool: "ffmpeg" });
    expect(fixed?.status).toBe("updated");
    expect(read("ffmpeg")).toContain("N-201-gfixed");
    expect(read("ffmpeg.prev")).toContain("N-122306-gold");
    state = readToolState(temp.db);
    expect(state.ffmpeg).toMatchObject({
      current: "N-201-gfixed",
      previous: "N-122306-gold",
      last_error: null,
      blocked_latest: null,
    });
  });

  it("swaps in a build when both the live and the staged one encode with NVENC", async () => {
    installLiveFfmpeg("N-122306-gold");
    const github = routedFetch(await stagedRelease("N-200-gok", "works", "2026-10-18T10:00:00Z"));
    const [outcome] = await checkToolUpdates(makeDeps(github), { tool: "ffmpeg" });
    expect(outcome?.status).toBe("updated");
    expect(read("ffmpeg")).toContain("N-200-gok");
    expect(readToolState(temp.db).ffmpeg.last_error).toBeNull();
  });

  it("does not hold back a build when the live ffmpeg has no working NVENC", async () => {
    writeFileSync(join(binDir, "ffmpeg"), nvencFfmpegScript("N-1-gcpu", "listed-but-fails"));
    writeFileSync(join(binDir, "ffprobe"), versionScript("ffprobe version N-1-gcpu Copyright"));
    const github = routedFetch(
      await stagedRelease("N-200-gnewapi", "listed-but-fails", "2026-10-18T10:00:00Z"),
    );
    const [outcome] = await checkToolUpdates(makeDeps(github), { tool: "ffmpeg" });
    expect(outcome?.status).toBe("updated");
    expect(read("ffmpeg")).toContain("N-200-gnewapi");
  });
});

describe("checkToolUpdates: failures are reported, never thrown", () => {
  it("records network errors for both tools", async () => {
    const outcomes = await checkToolUpdates(makeDeps(routedFetch()));
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["failed", "failed"]);
    expect(outcomes[0]?.detail).toBe("fetch failed: getaddrinfo ENOTFOUND api.github.com");
    const state = readToolState(temp.db);
    expect(state.ytdlp.last_error).toMatch(/fetch failed/);
    expect(state.ffmpeg.checked_at).toBe(1_000);
  });

  it("reports HTTP errors, bad metadata, missing assets and empty bodies", async () => {
    const http = routedFetch({ [YTDLP_RELEASE_API]: () => json({ message: "rate limited" }, 403) });
    expect((await checkToolUpdates(makeDeps(http), { tool: "ytdlp" }))[0]?.detail).toBe(
      `GET ${YTDLP_RELEASE_API} answered HTTP 403`,
    );

    const garbage = routedFetch({ [YTDLP_RELEASE_API]: () => json({ nope: true }) });
    expect((await checkToolUpdates(makeDeps(garbage), { tool: "ytdlp" }))[0]?.detail).toMatch(
      /unexpected release metadata/,
    );

    const noAsset = routedFetch({
      [YTDLP_RELEASE_API]: () => json({ tag_name: "2026.09.01", assets: [] }),
    });
    expect((await checkToolUpdates(makeDeps(noAsset), { tool: "ytdlp" }))[0]?.detail).toBe(
      `release 2026.09.01 has no ${YTDLP_ASSET} asset`,
    );

    const routes = githubRoutes({ ytdlpTag: "2026.09.01" });
    routes[`${DL}/${YTDLP_ASSET}`] = () => new Response(null, { status: 200 });
    const empty = routedFetch(routes);
    expect((await checkToolUpdates(makeDeps(empty), { tool: "ytdlp" }))[0]?.detail).toMatch(
      /returned no body/,
    );
  });

  it("reports a settings failure", async () => {
    const deps = makeDeps(routedFetch(), {
      getSettings: () => {
        throw new Error("settings unavailable");
      },
    });
    const [outcome] = await checkToolUpdates(deps, { tool: "ytdlp" });
    expect(outcome).toMatchObject({ status: "failed", detail: "settings unavailable" });
  });

  it("serialises concurrent runs", async () => {
    installYtdlp("2026.08.19");
    const github = routedFetch(githubRoutes({ ytdlpTag: "2026.09.01" }));
    const deps = makeDeps(github);
    const [first, second] = await Promise.all([
      checkToolUpdates(deps, { tool: "ytdlp" }),
      checkToolUpdates(deps, { tool: "ytdlp" }),
    ]);
    expect(first[0]?.status).toBe("updated");
    expect(second[0]?.status).toBe("up_to_date");
  });

  it("runs the daily tick on a timer and stops", async () => {
    const github = routedFetch();
    const stop = startToolUpdateSchedule(makeDeps(github), {
      initialDelayMs: 1,
      intervalMs: 60_000,
    });
    await expect.poll(() => readToolState(temp.db).ffmpeg.checked_at).toBe(1_000);
    stop();
    expect(github.calls).toContain(YTDLP_RELEASE_API);
  });
});

describe("kv.tool_versions", () => {
  it("reads the pre-updater flat shape as the current versions", () => {
    setKv(temp.db, TOOL_VERSIONS_KEY, { ytdlp: "2026.01.01", ffmpeg: "7.0", checkedAt: 5 });
    expect(readToolVersions(temp.db)).toEqual({ ytdlp: "2026.01.01", ffmpeg: "7.0" });
    expect(readToolState(temp.db).ytdlp.previous).toBeNull();
  });

  it("tolerates garbage in the stored row", () => {
    setKv(temp.db, TOOL_VERSIONS_KEY, { ytdlp: { current: 5, latest: "x" }, ffmpeg: null });
    const state = readToolState(temp.db);
    expect(state.ytdlp).toMatchObject({ current: null, latest: "x" });
    expect(state.ffmpeg.current).toBeNull();
    setKv(temp.db, TOOL_VERSIONS_KEY, "nonsense");
    expect(readToolVersions(temp.db)).toEqual({ ytdlp: null, ffmpeg: null });
  });

  it("records the baseline versions", async () => {
    const baseline = join(dir, "baseline");
    mkdirSync(baseline);
    writeFileSync(join(baseline, "yt-dlp"), "x");
    writeFileSync(join(baseline, "ffmpeg"), "x");
    const versions = await recordBaselineVersions(temp.db, baseline, log, async (file) =>
      file.endsWith("yt-dlp") ? "2026.08.19\n" : "ffmpeg version 7.1\n",
    );
    expect(versions).toEqual({ ytdlp: "2026.08.19", ffmpeg: "7.1" });
    expect(readToolState(temp.db).ffmpeg.baseline).toBe("7.1");
  });

  it("builds the tools response", () => {
    updateToolState(temp.db, (state) => {
      state.ytdlp.current = "a";
      state.ytdlp.latest = "b";
    });
    const response = buildToolsResponse(temp.db, settingsWith(), "http://pot.env:4416", [
      { tool: "ytdlp", status: "available", detail: "d" },
    ]);
    expect(response).toMatchObject({
      js_runtime: "node",
      pot_provider_url: "http://pot.env:4416",
      auto_update: true,
      outcomes: [{ tool: "ytdlp" }],
    });
    expect(response.ytdlp.update_available).toBe(true);
    expect(response.ytdlp).not.toHaveProperty("asset_updated_at");
    expect(buildToolsResponse(temp.db, settingsWith(), "x")).not.toHaveProperty("outcomes");
  });
});

describe("helpers", () => {
  it("parses checksum files", () => {
    const hex = "AB".repeat(32);
    expect(parseChecksum(`${hex} *yt-dlp_linux\r\n`, "yt-dlp_linux")).toBe(hex.toLowerCase());
    expect(() => parseChecksum("garbage", "yt-dlp_linux")).toThrow(/no checksum/);
  });

  it("describes errors with their cause", () => {
    expect(describeError("plain")).toBe("plain");
    expect(describeError(new Error("outer", { cause: new Error("inner") }))).toBe("outer: inner");
    expect(describeError(new Error("outer: inner", { cause: new Error("inner") }))).toBe(
      "outer: inner",
    );
  });

  it("resolves the PO token provider URL", () => {
    expect(resolvePotProviderUrl(settingsWith(), "http://env:1")).toBe("http://env:1");
    expect(
      resolvePotProviderUrl(settingsWith({ "tools.pot_provider_url": "http://mine:2/" }), "x"),
    ).toBe("http://mine:2");
    expect(resolvePotProviderUrl(settingsWith({ "tools.pot_provider_url": "" }), "x")).toBe("");
  });

  it("resolves tool commands: env override, bin dir, then PATH", () => {
    expect(toolEnvKey("yt-dlp")).toBe("CELLAR_TOOL_YT_DLP");
    const env = { CELLAR_TOOL_FFMPEG: JSON.stringify(["node", "/x/ffmpeg.mjs"]) };
    expect(resolveToolCommand("ffmpeg", binDir, env)).toEqual(["node", "/x/ffmpeg.mjs"]);
    expect(resolveToolCommand("ffmpeg", binDir, { CELLAR_TOOL_FFMPEG: "{bad" })).toEqual([
      "ffmpeg",
    ]);
    expect(resolveToolCommand("ffmpeg", binDir, { CELLAR_TOOL_FFMPEG: "[1]" })).toEqual(["ffmpeg"]);
    writeFileSync(join(binDir, "ffprobe"), "x");
    expect(resolveToolCommand("ffprobe", binDir, {})).toEqual([join(binDir, "ffprobe")]);
  });

  it("runs tools with the built-in runner", async () => {
    const env = {
      ...process.env,
      CELLAR_TOOL_YT_DLP: JSON.stringify([process.execPath, join(fakeBinDir, "yt-dlp.mjs")]),
      CELLAR_TOOL_FFMPEG: JSON.stringify([process.execPath, "-e", "process.exit(4)"]),
      CELLAR_TOOL_FFPROBE: JSON.stringify([process.execPath, "-e", "setTimeout(() => {}, 5000)"]),
    };
    const run = createRunTool({ binDir, env });
    const version = await run({ tool: "yt-dlp", args: ["--version"] });
    expect(version).toMatchObject({ code: 0, stdout: "2026.08.19-fake\n" });
    expect((await run({ tool: "ffmpeg", args: [] })).code).toBe(4);
    expect((await run({ tool: "ffprobe", args: [], timeoutMs: 200 })).code).toBeNull();
    const missing = createRunTool({
      binDir,
      env: { ...process.env, CELLAR_TOOL_FFMPEG: JSON.stringify([join(dir, "nope")]) },
    });
    await expect(missing({ tool: "ffmpeg", args: [] })).rejects.toMatchObject({ code: "ENOENT" });
    // Default env (process.env) and default timeout.
    vi.stubEnv("CELLAR_TOOL_FFMPEG", JSON.stringify([process.execPath, "-e", "process.exit(0)"]));
    try {
      await expect(createRunTool({ binDir })({ tool: "ffmpeg", args: [] })).resolves.toMatchObject({
        code: 0,
      });
    } finally {
      vi.unstubAllEnvs();
    }
    await expect(runFile(process.execPath, ["-e", "1"])).resolves.toMatchObject({ code: 0 });
  });

  it("keeps the download route table honest", async () => {
    const github = routedFetch({ [`${DL}/x`]: () => bytes("hi") });
    expect(await (await github.fetch(new URL(`${DL}/x`))).text()).toBe("hi");
    expect(await (await github.fetch(new Request(`${DL}/x`))).text()).toBe("hi");
  });
});
