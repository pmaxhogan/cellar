import { existsSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import {
  BYTES_PER_GB,
  expect,
  removeDir,
  scratchDir,
  test,
  toContainerPath,
  toastWith,
  uniqueName,
} from "./helpers.ts";

/**
 * Storage locations: the seeded /media card, quotas and the usage bar, and the
 * full life of a second location backed by a real directory.
 */

function card(page: Page, label: string): Locator {
  return page.locator("[data-location]").filter({
    has: page.getByRole("heading", { level: 2, name: label, exact: true }),
  });
}

async function typeNumber(input: Locator, value: string): Promise<void> {
  await input.click();
  await input.press("ControlOrMeta+a");
  await input.pressSequentially(value);
  await input.press("Tab");
}

test.describe.configure({ mode: "serial" });

test.afterEach(async ({ api }) => {
  await api.deleteOwned("locations");
});

test("the seeded /media location renders and takes a quota", async ({ page, api }) => {
  const seeded = (await api.locations()).find((row) => row.container_path === "/media");
  expect(seeded, "the first boot seeds a /media location").toBeDefined();
  const media = seeded!;

  try {
    await api.send("PATCH", `/api/locations/${String(media.id)}`, { quota_bytes: 0 });
    await page.goto("/locations");
    const mediaCard = card(page, media.label);
    await expect(mediaCard).toBeVisible();
    await expect(mediaCard.locator('[data-fact="path"]')).toHaveText("/media");
    // Locally there is normally no /media; in the image it is a bind mount.
    await expect(mediaCard.locator('[data-fact="mounted"]')).toHaveText(
      media.mounted ? "Mounted" : "Not mounted",
    );
    await expect(mediaCard.getByTestId("usage-percent")).toHaveText("no quota");

    await mediaCard.locator('[data-action="edit"]').click();
    const dialog = page.getByRole("dialog", { name: "Edit location" });
    await expect(dialog).toBeVisible();
    // The path is fixed once a location exists.
    await expect(dialog.getByLabel("Container path")).toBeDisabled();
    await typeNumber(dialog.getByLabel("Quota (GB)"), "10");
    await expect(dialog.getByTestId("quota-preview")).toContainText("10.0 GB");
    await dialog.locator('[data-action="save-location"]').click();
    await expect(dialog).toBeHidden();
    await expect(toastWith(page, "Location saved")).toBeVisible();

    await expect(mediaCard.getByTestId("usage-text")).toHaveText(/of 10\.0 GB quota used$/);
    await expect(mediaCard.getByTestId("usage-percent")).toHaveText(/^\d+\.\d%$/);
    await expect(mediaCard.getByRole("progressbar", { name: "Quota used" })).toHaveAttribute(
      "aria-valuenow",
      /^\d+$/,
    );
    await expect
      .poll(async () => (await api.locations()).find((row) => row.id === media.id)?.quota_bytes)
      .toBe(10 * BYTES_PER_GB);

    await page.reload();
    await expect(mediaCard.getByTestId("usage-text")).toHaveText(/of 10\.0 GB quota used$/);
  } finally {
    await api.send("PATCH", `/api/locations/${String(media.id)}`, { quota_bytes: 0 });
  }
});

test("the add form rejects a relative path before sending it", async ({ page }) => {
  await page.goto("/locations");
  await page.locator('[data-action="add-location"]').click();
  const dialog = page.getByRole("dialog", { name: "Add location" });
  await dialog.getByLabel("Label").fill(uniqueName("Relative"));
  await dialog.getByLabel("Container path").fill("media2");
  await typeNumber(dialog.getByLabel("Quota (GB)"), "1");
  await dialog.locator('[data-action="save-location"]').click();
  await expect(dialog.getByTestId("path-error")).toHaveText(/absolute path/);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

test("a location on a real directory is added, toggled and deleted", async ({ page, api }) => {
  const dir = scratchDir("location");
  const label = uniqueName("Scratch");
  try {
    await page.goto("/locations");
    await page.locator('[data-action="add-location"]').click();
    const dialog = page.getByRole("dialog", { name: "Add location" });
    await expect(dialog.getByTestId("mount-note")).toBeVisible();
    await dialog.getByLabel("Label").fill(label);
    await dialog.getByLabel("Container path").fill(toContainerPath(dir));
    await typeNumber(dialog.getByLabel("Quota (GB)"), "2");
    await dialog.locator('[data-action="save-location"]').click();
    await expect(dialog).toBeHidden();
    await expect(toastWith(page, "Location added")).toBeVisible();

    const added = card(page, label);
    await expect(added).toBeVisible();
    // The directory exists, so the live filesystem facts say mounted.
    await expect(added.locator('[data-fact="mounted"]')).toHaveText("Mounted");
    await expect(added.locator('[data-fact="enabled"]')).toHaveText("Enabled");
    await expect(added.getByTestId("usage-text")).toHaveText(/of 2\.00 GB quota used$/);
    await expect(added.getByTestId("usage-free")).toContainText("free on the filesystem");

    const row = (await api.locations()).find((candidate) => candidate.label === label);
    expect(row?.quota_bytes).toBe(2 * BYTES_PER_GB);
    expect(row?.mounted).toBe(true);

    await added.locator('[data-action="toggle"]').click();
    await expect(added.locator('[data-fact="enabled"]')).toHaveText("Disabled");
    await expect(toastWith(page, "Location disabled")).toBeVisible();
    await page.reload();
    await expect(added.locator('[data-fact="enabled"]')).toHaveText("Disabled");

    await added.locator('[data-action="toggle"]').click();
    await expect(added.locator('[data-fact="enabled"]')).toHaveText("Enabled");

    await added.locator('[data-action="remove"]').click();
    const confirm = page.getByRole("dialog", { name: "Delete location?" });
    await expect(confirm).toContainText(label);
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(confirm).toBeHidden();
    await expect(added).toHaveCount(0);
    await expect
      .poll(async () => (await api.locations()).some((candidate) => candidate.label === label))
      .toBe(false);
    // Unregistering never touches the files on disk.
    expect(existsSync(dir)).toBe(true);
  } finally {
    removeDir(dir);
  }
});

test("a path that is not a directory is refused by the server", async ({ page }) => {
  // A path that existed a moment ago and does not now.
  const gone = scratchDir("gone");
  removeDir(gone);
  const missing = toContainerPath(gone);
  await page.goto("/locations");
  await page.locator('[data-action="add-location"]').click();
  const dialog = page.getByRole("dialog", { name: "Add location" });
  await dialog.getByLabel("Label").fill(uniqueName("Missing"));
  await dialog.getByLabel("Container path").fill(missing);
  await typeNumber(dialog.getByLabel("Quota (GB)"), "1");
  await dialog.locator('[data-action="save-location"]').click();
  await expect(dialog.getByTestId("location-form-error")).toContainText(
    "not an existing directory",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
});
