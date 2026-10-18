import { expect, test, toastWith } from "./helpers.ts";

/**
 * Activity (the jobs table and manual actions) and the self-check page. The
 * self-check runs the fake tools from scripts/fake-bin, so the tool checks
 * have a known answer.
 */

interface JobBody {
  id: number;
  type: string;
  status: string;
}

test("the self-check action is queued, or reported as not available yet", async ({ page, api }) => {
  const probe = await api.raw("POST", "/api/actions/selfcheck");
  expect([202, 501]).toContain(probe.status());

  await page.goto("/activity");
  const button = page.locator('[data-run-action="selfcheck"]');
  await expect(button).toBeVisible();

  if (probe.status() === 501) {
    expect(await probe.json()).toMatchObject({ code: "not_implemented" });
    await button.click();
    await expect(toastWith(page, "Self-check is not available yet")).toBeVisible();
    await expect(button).toHaveAttribute("data-unavailable", "true");
    await expect(button).toHaveAttribute("title", /Not available yet on this server\./);
    return;
  }

  // The action exists: the job the probe queued runs to the end.
  const { job_id: queued } = (await probe.json()) as { job_id: number };
  await expect
    .poll(async () => (await api.get<JobBody>(`/api/jobs/${String(queued)}`)).status, {
      timeout: 30_000,
    })
    .toBe("done");

  await button.click();
  await expect(toastWith(page, "Self-check queued")).toBeVisible();
  await page.locator('[data-tab="jobs"]').click();
  await expect(page.locator(`[data-job="${String(queued)}"]`)).toBeVisible();
});

test("the jobs table lists the jobs the server has run", async ({ page, api }) => {
  const jobs = await api.get<{ rows: JobBody[]; total: number }>("/api/jobs?perPage=25");
  expect(jobs.total).toBeGreaterThan(0);
  const newest = jobs.rows[0]!;

  await page.goto("/activity");
  // The activity log is the first tab and renders rows or its empty state.
  await expect(
    page.getByText("No activity yet").or(page.locator("[data-activity]").first()),
  ).toBeVisible();

  await page.locator('[data-tab="jobs"]').click();
  const row = page
    .getByRole("row")
    .filter({ has: page.locator(`[data-job="${String(newest.id)}"]`) });
  await expect(row).toBeVisible();
  await expect(row).toContainText(newest.type);
  await expect(row.locator("[data-job-status]")).toHaveText(newest.status);
  await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();
});

test("the self-check page runs every check and the fake tools pass", async ({ page, api }) => {
  const before = await api.get<{ rows: { id: number }[] }>("/api/checks?limit=50");

  await page.goto("/self-check");
  // The boot run is in the history either way.
  await expect(page.locator("[data-run]").first()).toBeVisible();

  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        new URL(candidate.url()).pathname === "/api/checks/run",
      { timeout: 45_000 },
    ),
    page.locator('[data-action="run"]').click(),
  ]);
  expect(response.status()).toBe(200);
  const run = (await response.json()) as { id: number; trigger: string };
  expect(run.trigger).toBe("manual");

  await expect(page.locator("[data-running]")).toHaveCount(0);
  await expect(page.locator("[data-summary]")).toContainText("(manual)");

  // One card per group of checks.
  for (const group of ["data", "db", "tools", "push"]) {
    await expect(page.locator(`[data-group="${group}"]`)).toBeVisible();
  }
  await expect(page.locator('[data-group="tools"] h3')).toHaveText("Tools");

  // The fake binaries answer --version and the 1 s dry run.
  for (const check of ["tools.ytdlp", "tools.ffmpeg", "tools.ffprobe", "tools.ffprobe_dry_run"]) {
    await expect(page.locator(`[data-check="${check}"]`)).toHaveAttribute("data-level", "ok");
  }
  await expect(page.locator('[data-check="tools.ytdlp"]')).toContainText("2026.08.19-fake");
  await expect(page.locator('[data-check="db.integrity"]')).toHaveAttribute("data-level", "ok");

  // The run is in the history, newest first.
  await expect(page.locator(`[data-run="${String(run.id)}"]`)).toBeVisible();
  const after = await api.get<{ rows: { id: number }[] }>("/api/checks?limit=50");
  expect(after.rows.length).toBeGreaterThan(before.rows.length);
  expect(after.rows[0]!.id).toBe(run.id);
});

test("the latest run is shown as soon as the page opens", async ({ page, api }) => {
  // GET /api/checks/latest answers { row: CheckRow | null }; the page reads the
  // envelope and opens on the stored run, not on an error.
  const latest = await api.get<{ row: { id: number } | null }>("/api/checks/latest");
  expect(latest.row).not.toBeNull();

  await page.goto("/self-check");
  await expect(page.locator("[data-summary]")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("Could not load the latest self-check")).toHaveCount(0);
});
