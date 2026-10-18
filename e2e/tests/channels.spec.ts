import { expect, test, toastWith, uniqueChannelId } from "./helpers.ts";

/**
 * Manual channels. A UC id needs no account; a handle has to be resolved
 * through a linked account's API access, so without one it is explained, not
 * silently dropped.
 */

test("a channel added by UC id is listed as manual, searchable and removable", async ({
  page,
  api,
}) => {
  const id = uniqueChannelId();
  try {
    await page.goto("/channels");
    await page.locator('[data-action="add-channel"]').click();
    const dialog = page.getByRole("dialog", { name: "Add channel" });
    await dialog.getByLabel("Channel URL, @handle or UC channel id").fill(id);
    await expect(dialog.getByTestId("ref-kind")).toContainText(id);
    await dialog.locator('[data-action="add-channel-submit"]').click();
    await expect(dialog).toBeHidden();
    await expect(toastWith(page, "Channel added")).toBeVisible();

    const row = page.getByRole("row").filter({ hasText: id });
    await expect(row).toBeVisible();
    await expect(row.getByText("Manual", { exact: true })).toBeVisible();
    await expect(row.locator(`[data-channel="${id}"]`)).toHaveAttribute("href", new RegExp(id));

    // Search matches the exact id for a channel with no title or handle yet.
    const search = page.getByTestId("channel-search");
    await search.fill(id);
    await search.press("Enter");
    await expect(row).toBeVisible();
    await expect(page.getByTestId("channel-total")).toHaveText("1 channel");

    await search.fill(`no-such-channel-${id}`);
    await search.press("Enter");
    await expect(page.getByTestId("no-matches")).toBeVisible();
    await page.getByTestId("no-matches").getByRole("button", { name: "Clear filters" }).click();
    await expect(search).toHaveValue("");
    await expect(row).toBeVisible();

    // The Manual filter keeps it; Subscribed does not.
    await page.getByTestId("channel-kind").getByText("Subscribed", { exact: true }).click();
    await expect(row).toHaveCount(0);
    // An empty table is not enough: a rejected filter also hides the row.
    await expect(page.getByText("Could not load channels")).toHaveCount(0);
    await page.getByTestId("channel-kind").getByText("Manual", { exact: true }).click();
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: `Remove ${id}` }).click();
    const confirm = page.getByRole("dialog", { name: "Remove channel?" });
    await confirm.getByRole("button", { name: "Remove" }).click();
    await expect(confirm).toBeHidden();
    await expect(toastWith(page, "Channel removed")).toBeVisible();
    await expect(row).toHaveCount(0);

    // Removing stops the manual follow; the channel row itself is kept (videos
    // may reference it), so it leaves the manual list rather than the table.
    const manual = await api.get<{ rows: { id: string }[] }>(`/api/channels?kind=manual&q=${id}`);
    expect(manual.rows).toEqual([]);
    const all = await api.get<{ rows: { id: string; manual: boolean }[] }>(`/api/channels?q=${id}`);
    expect(all.rows.every((channel) => !channel.manual)).toBe(true);
  } finally {
    await api.send("DELETE", `/api/channels/${id}`, undefined, [204, 404]);
  }
});

test("a handle with no linked account explains why it cannot be added", async ({ page, api }) => {
  await page.goto("/channels");
  await page.locator('[data-action="add-channel"]').click();
  const dialog = page.getByRole("dialog", { name: "Add channel" });
  await dialog.getByLabel("Channel URL, @handle or UC channel id").fill("@cellar-e2e-handle");
  await expect(dialog.getByTestId("ref-kind")).toContainText("Resolved to a channel id");
  await dialog.locator('[data-action="add-channel-submit"]').click();
  const explanation = dialog.getByTestId("no-account");
  await expect(explanation).toBeVisible();
  await expect(explanation).toContainText("No linked account could resolve this reference");
  await expect(explanation.getByRole("link", { name: "Accounts page" })).toHaveAttribute(
    "href",
    "/accounts",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();

  const response = await api.raw("POST", "/api/channels", { ref: "@cellar-e2e-handle" });
  expect(await response.json()).toMatchObject({ code: "no_account" });
});

test("a video link is not accepted as a channel", async ({ page }) => {
  await page.goto("/channels");
  await page.locator('[data-action="add-channel"]').click();
  const dialog = page.getByRole("dialog", { name: "Add channel" });
  await dialog
    .getByLabel("Channel URL, @handle or UC channel id")
    .fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await expect(dialog.locator('[data-action="add-channel-submit"]')).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
});
