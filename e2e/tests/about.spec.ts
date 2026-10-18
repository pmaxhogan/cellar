import { expect, test, toastWith } from "./helpers.ts";

/**
 * About: the versions this instance runs, and the tool update check. The check
 * asks GitHub for the newest releases, which may or may not be reachable from
 * where the suite runs, so either outcome is accepted as long as the server
 * records it and the page survives.
 */

interface ToolInfo {
  current: string | null;
  checked_at: number | null;
  last_error: string | null;
}

interface ToolsBody {
  ytdlp: ToolInfo;
  ffmpeg: ToolInfo;
  js_runtime: string | null;
  pot_provider_url: string | null;
}

test.afterEach(async ({ api }) => {
  await api.putSettings({ "tools.auto_update": null });
});

test("versions and runtime facts render", async ({ page, api }) => {
  const status = await api.status();
  const tools = await api.get<ToolsBody>("/api/tools");

  await page.goto("/about");
  await expect(page.getByRole("heading", { level: 1, name: "About" })).toBeVisible();
  await expect(page.locator('[data-fact="version"]')).toContainText(status.version);
  await expect(page.locator('[data-fact="auth"]')).toHaveText("disabled");
  await expect(page.locator('[data-fact="db"]')).toHaveText(
    `ok, ${String(status.db.migrations)} migrations`,
  );

  for (const name of ["ytdlp", "ffmpeg"] as const) {
    const row = page.locator(`[data-tool-row="${name}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator('[data-version="current"]')).toHaveText(
      tools[name].current ?? "not found",
    );
    // Nothing to roll back to on a fresh data directory.
    await expect(row.locator('[data-tool-action="rollback"]')).toBeDisabled();
  }
  await expect(page.locator('[data-fact="js-runtime"]')).toHaveText(
    tools.js_runtime ?? "none detected",
  );
  await expect(page.locator('[data-fact="pot-provider"]')).toHaveText(
    tools.pot_provider_url ?? "not set",
  );
});

test("check for updates records an outcome and leaves the page working", async ({ page, api }) => {
  // Two GitHub lookups with a 30 s budget each when the network is slow.
  test.setTimeout(150_000);
  // Only look, never install: with auto-update on, a check would download
  // real yt-dlp and ffmpeg builds into the data directory.
  await api.putSettings({ "tools.auto_update": false });

  await page.goto("/about");
  const check = page.locator('[data-tool-action="check"]');
  await expect(check).toBeEnabled();

  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        new URL(candidate.url()).pathname === "/api/tools/update",
      { timeout: 120_000 },
    ),
    check.click(),
  ]);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as ToolsBody & {
    outcomes?: { tool: string; status: string; detail?: string }[];
  };

  // Every tool was checked, and the time of the check is shown.
  for (const name of ["ytdlp", "ffmpeg"] as const) {
    expect(body[name].checked_at).not.toBeNull();
    await expect(page.locator(`[data-tool-row="${name}"] [data-version="checked"]`)).not.toHaveText(
      "never",
    );
  }
  await expect(
    toastWith(page, /Tools are up to date|Updates available|Could not check for updates/),
  ).toBeVisible();
  await expect(check).toBeEnabled();

  // Offline (or rate limited) the server records the failure per tool.
  const failed = (body.outcomes ?? []).filter((outcome) => outcome.status === "failed");
  const stored = await api.get<ToolsBody>("/api/tools");
  for (const outcome of failed) {
    const key = outcome.tool as "ytdlp" | "ffmpeg";
    expect(stored[key].last_error).not.toBeNull();
  }

  // Nothing was installed: the fake tools are still the ones that run.
  const selfcheck = await api.send<{ results: { key: string; detail: string }[] }>(
    "POST",
    "/api/checks/run",
  );
  expect(selfcheck.results.find((result) => result.key === "tools.ytdlp")?.detail).toContain(
    "fake",
  );

  await page.reload();
  await expect(page.locator('[data-tool-row="ytdlp"]')).toBeVisible();
});
