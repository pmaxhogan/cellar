import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const run = promisify(execFile);

/**
 * Packaging smoke for the built image.
 *
 * Everything is probed from INSIDE the container with `docker exec`, because
 * insecure mode binds 127.0.0.1 and a published port DNATs to the container's
 * own interface: a host side request would never arrive. The browser flows in
 * the other specs cover the UI against the same build running under node, so
 * what is left to prove here is that the image itself carries the binaries and
 * boots.
 *
 * Skipped unless CELLAR_E2E_IMAGE names an image, so the suite still runs on a
 * machine with no docker.
 */

const image = process.env.CELLAR_E2E_IMAGE;

test.describe("docker image", () => {
  test.skip(image === undefined, "set CELLAR_E2E_IMAGE to smoke test a built image");

  let container: string | null = null;

  test.afterAll(async () => {
    if (container !== null) {
      await run("docker", ["rm", "-f", container]).catch(() => undefined);
    }
  });

  test("boots, answers healthz, serves both bundles and carries the tools", async () => {
    test.setTimeout(180_000);

    const started = await run("docker", [
      "run",
      "-d",
      "--rm",
      "-e",
      "INSECURE_ALLOW_PUBLIC_ACCESS=1",
      "-e",
      `CELLAR_SECRET_KEY=${"a".repeat(64)}`,
      "-e",
      "LOG_LEVEL=warn",
      image!,
    ]);
    container = started.stdout.trim();
    expect(container).not.toBe("");

    const exec = async (...argv: string[]): Promise<string> => {
      const { stdout } = await run("docker", ["exec", container!, ...argv]);
      return stdout.trim();
    };

    // The baseline tools the image ships, found through its PATH.
    expect(await exec("yt-dlp", "--version")).toMatch(/^\d{4}\.\d{2}\.\d{2}/);
    expect(await exec("sh", "-c", "ffmpeg -hide_banner -version | head -n 1")).toContain(
      "ffmpeg version",
    );
    expect(await exec("sh", "-c", "ffprobe -hide_banner -version | head -n 1")).toContain(
      "ffprobe version",
    );

    // The server needs a moment to migrate and bind before healthz answers.
    let health = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      health = await exec("sh", "-c", "curl -fsS http://127.0.0.1:8080/healthz || true");
      if (health.includes('"ok":true')) break;
      await new Promise((done) => setTimeout(done, 2_000));
    }
    expect(health, "healthz never returned ok inside the container").toContain('"ok":true');

    const statusOf = (path: string): Promise<string> =>
      exec("sh", "-c", `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080${path}`);

    // The image ships the built frontend: the root is the SPA, not an API-only 404,
    // and the public share bundle answers an unknown token with its own 404.
    expect(await statusOf("/")).toBe("200");
    expect(await statusOf("/s/privacy")).toBe("200");
    expect(await statusOf("/s/nope")).toBe("404");
    expect(await statusOf("/api/status")).toBe("200");
  });
});
