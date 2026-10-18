import type { Locator, Page } from "@playwright/test";
import { expect, test, toastWith } from "./helpers.ts";

/**
 * The global settings editor: a sparse override store. Saving writes only
 * what changed, a reset clears the override instead of storing the default,
 * and invalid values never reach the server.
 */

// No max on this one, so the InputNumber cannot clamp what the test types.
const KEY = "eval.interval_minutes";
const LABEL = "Full evaluation interval";
const DEFAULT = 60;

function field(page: Page, key: string): Locator {
  return page.locator(`[data-setting="${key}"]`);
}

/** PrimeVue's InputNumber commits its model on blur, not on every keystroke. */
async function typeNumber(input: Locator, value: string): Promise<void> {
  await input.click();
  await input.press("ControlOrMeta+a");
  if (value === "") await input.press("Backspace");
  else await input.pressSequentially(value);
  await input.press("Tab");
}

test.describe.configure({ mode: "serial" });

const TOUCHED = { [KEY]: null, "reaper.low_water_pct": null, "reaper.high_water_pct": null };

// Start and finish on the defaults, so no other spec sees these overrides.
test.beforeEach(async ({ api }) => {
  await api.putSettings(TOUCHED);
});

test.afterEach(async ({ api }) => {
  await api.putSettings(TOUCHED);
});

test("a changed number is saved, persists across a reload and can be reset", async ({
  page,
  api,
}) => {
  await page.goto("/settings");
  const row = field(page, KEY);
  const input = page.getByLabel(LABEL, { exact: true });
  await expect(input).toHaveValue(String(DEFAULT));
  await expect(row.getByTestId("modified")).toHaveCount(0);
  await expect(row.getByTestId("default")).toHaveText(`Default: ${String(DEFAULT)} minutes`);

  await typeNumber(input, "45");
  await expect(row.getByTestId("unsaved")).toBeVisible();
  await expect(page.getByTestId("dirty-count")).toHaveText("1 unsaved change");

  await page.locator('[data-action="save"]').click();
  await expect(toastWith(page, "Settings saved")).toBeVisible();
  await expect(row.getByTestId("modified")).toBeVisible();
  await expect(row.getByTestId("unsaved")).toHaveCount(0);
  await expect.poll(async () => (await api.settings())[KEY]).toBe(45);

  await page.reload();
  await expect(input).toHaveValue("45");
  await expect(row.getByTestId("modified")).toBeVisible();

  // Reset clears the stored override rather than writing the default back.
  await row.locator('[data-action="reset"]').click();
  await expect(input).toHaveValue(String(DEFAULT));
  await expect(page.getByTestId("dirty-count")).toHaveText("1 unsaved change");
  await page.locator('[data-action="save"]').click();
  await expect(toastWith(page, "Settings saved")).toBeVisible();
  await expect(row.getByTestId("modified")).toHaveCount(0);
  await expect.poll(async () => KEY in (await api.settings())).toBe(false);

  await page.reload();
  await expect(input).toHaveValue(String(DEFAULT));
  await expect(row.getByTestId("modified")).toHaveCount(0);
});

test("discard drops unsaved edits", async ({ page, api }) => {
  await page.goto("/settings");
  const input = page.getByLabel(LABEL, { exact: true });
  await typeNumber(input, "30");
  await expect(page.getByTestId("dirty-count")).toBeVisible();
  await page.locator('[data-action="discard"]').click();
  await expect(input).toHaveValue(String(DEFAULT));
  await expect(page.getByTestId("dirty-count")).toHaveCount(0);
  expect(KEY in (await api.settings())).toBe(false);
});

test("an empty number is rejected before anything is sent", async ({ page, api }) => {
  await page.goto("/settings");
  const row = field(page, KEY);
  const input = page.getByLabel(LABEL, { exact: true });

  let puts = 0;
  page.on("request", (request) => {
    if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/settings") {
      puts += 1;
    }
  });

  await typeNumber(input, "");
  await page.locator('[data-action="save"]').click();
  await expect(row.getByTestId("error")).toHaveText("Enter a value.");
  await expect(page.getByTestId("field-errors")).toContainText("1 setting need attention");
  await expect(toastWith(page, "Not saved")).toBeVisible();
  expect(puts).toBe(0);
  expect(KEY in (await api.settings())).toBe(false);

  // Fixing the value clears the error.
  await typeNumber(input, "50");
  await expect(row.getByTestId("error")).toHaveCount(0);
  await page.locator('[data-action="discard"]').click();
});

test("a cross-setting invariant is reported on the field it breaks", async ({ page, api }) => {
  await page.goto("/settings");
  const low = field(page, "reaper.low_water_pct");
  // 99 is inside the field's own 1..100 range, but above the 95% start mark.
  await typeNumber(low.getByRole("spinbutton"), "99");
  await page.locator('[data-action="save"]').click();
  await expect(low.getByTestId("error")).toHaveText(
    "Must be lower than the start-reaping threshold",
  );
  expect("reaper.low_water_pct" in (await api.settings())).toBe(false);

  // The server enforces the same rule for a client that skips the UI.
  const response = await api.raw("PUT", "/api/settings", { "reaper.low_water_pct": 99 });
  expect(response.status()).toBe(400);
  await page.locator('[data-action="discard"]').click();
});
