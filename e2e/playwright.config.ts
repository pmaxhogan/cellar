import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/**
 * End to end suite for the real server.
 *
 * INSECURE_ALLOW_PUBLIC_ACCESS binds 127.0.0.1 inside the process, which is
 * exactly what a browser on the same host wants and exactly what a published
 * container port cannot reach: `docker run -p 8080:8080` DNATs to the
 * container's own interface, so a host side request never arrives. The UI
 * flows therefore drive the built server directly under node, and the image is
 * smoke tested from inside the container instead (tests/dockerImage.spec.ts),
 * which covers the packaging without fighting the loopback bind.
 *
 * Every run gets a fresh DATA_DIR, so a database left over from an earlier run
 * can never make a test pass that should have failed. Specs share that one
 * database, so each names the rows it creates uniquely and removes them again
 * (see tests/helpers.ts) instead of resetting anything.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.CELLAR_E2E_PORT ?? 8099);
const baseURL = process.env.CELLAR_E2E_BASE_URL ?? `http://127.0.0.1:${String(port)}`;
const dataDir = process.env.CELLAR_E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), "cellar-e2e-"));

/**
 * The fake yt-dlp / ffmpeg / ffprobe from scripts/fake-bin, started as
 * `node <tool>.mjs` so the same override works on Windows (where a .cmd
 * launcher cannot be spawned without a shell) and on Linux CI. The self-check,
 * cookie validation and version probes then never run a real binary.
 */
function fakeTool(name: string): string {
  return JSON.stringify([process.execPath, join(repoRoot, "scripts", "fake-bin", `${name}.mjs`)]);
}

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  // Nothing here talks to a slow remote; a test that needs a minute is stuck.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    // The web components mark their hooks with data-test, not data-testid.
    testIdAttribute: "data-test",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node server/dist/index.js",
    cwd: repoRoot,
    url: `${baseURL}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NODE_ENV: "production",
      INSECURE_ALLOW_PUBLIC_ACCESS: "1",
      DATA_DIR: dataDir,
      PORT: String(port),
      PUBLIC_ORIGIN: baseURL,
      // A throwaway key: this instance stores no real credentials.
      CELLAR_SECRET_KEY: "a".repeat(64),
      // warn would print every expected tool probe miss into the test output.
      LOG_LEVEL: "error",
      CELLAR_TOOL_YT_DLP: fakeTool("yt-dlp"),
      CELLAR_TOOL_FFMPEG: fakeTool("ffmpeg"),
      CELLAR_TOOL_FFPROBE: fakeTool("ffprobe"),
      // The self-check's dry run encodes a 1 s clip and expects ffprobe to say 1 s.
      FAKE_FFPROBE_DURATION: "1",
      // No PO token sidecar here: refuse at once instead of resolving "bgutil" in DNS.
      POT_PROVIDER_URL: "http://127.0.0.1:1",
      CELLAR_YTDLP_PLUGIN_DIRS: "",
    },
  },
});
