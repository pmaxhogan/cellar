import type { Locator, Page } from "@playwright/test";
import { expect, test, toastWith, uniqueName } from "./helpers.ts";

/**
 * Accounts: create, the Google link hand-off, the cookie jar (validated by the
 * fake yt-dlp, never the network), disable / enable and delete.
 */

/** A synthetic Netscape jar; the values are not real cookies of anyone. */
const COOKIES = [
  "# Netscape HTTP Cookie File",
  ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\te2e-fake-sid",
  ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tHSID\te2e-fake-hsid",
  "",
].join("\n");

function accountCard(page: Page, label: string): Locator {
  return page.locator("[data-account]").filter({
    has: page.getByRole("heading", { level: 2, name: label, exact: true }),
  });
}

test.afterEach(async ({ api }) => {
  await api.deleteOwned("accounts");
});

test("an account is added, linked, given cookies, toggled and deleted", async ({ page, api }) => {
  const label = uniqueName("Account");

  await page.goto("/accounts");
  await page.locator('[data-action="add-account"]').click();
  const dialog = page.getByRole("dialog", { name: "Add account" });
  await dialog.getByLabel("Label").fill(label);
  await dialog.locator('[data-action="save-account"]').click();
  await expect(dialog.getByTestId("account-created")).toContainText(label);
  await dialog.getByRole("button", { name: "Later" }).click();
  await expect(dialog).toBeHidden();

  const card = accountCard(page, label);
  await expect(card).toBeVisible();
  await expect(card.locator("[data-status]")).toHaveAttribute("data-status", "pending");
  await expect(card.locator("[data-status]")).toHaveText("Pending");
  await expect(card.locator('[data-fact="email"]')).toHaveText("Not linked to Google yet");
  await expect(card.locator('[data-fact="cookies"]')).toHaveText("None");

  const account = (await api.accounts()).find((row) => row.label === label);
  expect(account).toBeDefined();
  const id = account!.id;

  // The Link button hands the browser to the OAuth start route for this account.
  const link = card.locator('[data-action="link"]');
  await expect(link).toHaveText("Link Google account");
  const [started] = await Promise.all([
    page.waitForRequest((request) => request.url().includes("/api/oauth/google/start")),
    link.click(),
  ]);
  const startUrl = new URL(started.url());
  expect(startUrl.pathname).toBe("/api/oauth/google/start");
  expect(startUrl.searchParams.get("account")).toBe(String(id));

  // Without GOOGLE_CLIENT_ID the start route explains instead of redirecting.
  const start = await api.raw("GET", `/api/oauth/google/start?account=${String(id)}`);
  expect(start.status()).toBe(409);
  expect(await start.json()).toMatchObject({ code: "conflict" });
  expect(((await start.json()) as { error: string }).error).toContain("GOOGLE_CLIENT_ID");

  await page.goto("/accounts");
  await card.locator('[data-action="cookies"]').click();
  const cookies = page.getByRole("dialog", { name: `Cookies for ${label}` });
  await cookies.getByLabel("Paste cookies.txt").fill(COOKIES);
  await cookies.locator('[data-action="save-cookies"]').click();
  const result = cookies.getByTestId("cookies-result");
  await expect(result).toHaveAttribute("data-ok", "true");
  await expect(result).toContainText("Cookies saved and working.");
  await cookies.getByRole("button", { name: "Done" }).click();
  await expect(cookies).toBeHidden();

  await expect(card.locator('[data-fact="cookies"]')).toHaveText("Stored");
  await expect(card.locator('[data-action="cookies"]')).toHaveText("Replace cookies");
  await expect(card.locator('[data-fact="cookie-ok"]')).not.toHaveText("never");
  await expect
    .poll(async () => (await api.accounts()).find((row) => row.id === id)?.has_cookies)
    .toBe(true);
  // Still pending: a working jar alone is not enough without the Google link.
  await expect(card.locator("[data-status]")).toHaveAttribute("data-status", "pending");

  await card.locator('[data-action="toggle"]').click();
  await expect(card.locator("[data-status]")).toHaveAttribute("data-status", "disabled");
  await expect(toastWith(page, "Account disabled")).toBeVisible();
  await expect(card.locator('[data-action="toggle"]')).toHaveText("Enable");
  await page.reload();
  await expect(card.locator("[data-status]")).toHaveAttribute("data-status", "disabled");

  await card.locator('[data-action="toggle"]').click();
  await expect(card.locator("[data-status]")).toHaveAttribute("data-status", "pending");
  await expect(toastWith(page, "Account enabled")).toBeVisible();

  await card.locator('[data-action="remove"]').click();
  const confirm = page.getByRole("dialog", { name: "Delete account?" });
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(confirm).toBeHidden();
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await api.accounts()).some((row) => row.id === id)).toBe(false);
});

test("a jar that is not Netscape format is refused with the reason", async ({ page }) => {
  const label = uniqueName("Bad jar");
  await page.goto("/accounts");
  await page.locator('[data-action="add-account"]').click();
  const dialog = page.getByRole("dialog", { name: "Add account" });
  await dialog.getByLabel("Label").fill(label);
  await dialog.locator('[data-action="save-account"]').click();
  await dialog.getByRole("button", { name: "Later" }).click();

  const card = accountCard(page, label);
  await card.locator('[data-action="cookies"]').click();
  const cookies = page.getByRole("dialog", { name: `Cookies for ${label}` });
  await cookies.getByLabel("Paste cookies.txt").fill("this is not a cookie jar");
  await cookies.locator('[data-action="save-cookies"]').click();
  await expect(cookies.getByTestId("cookies-error")).toContainText("Netscape");
  await cookies.getByRole("button", { name: "Cancel" }).click();
  await expect(card.locator('[data-fact="cookies"]')).toHaveText("None");
});

test("the OAuth callback's error code is shown once and cleared from the URL", async ({ page }) => {
  await page.goto("/accounts?error=state_invalid");
  await expect(toastWith(page, "Linking did not finish")).toContainText("expired");
  await expect(page).toHaveURL((url) => url.pathname === "/accounts" && url.search === "");
});
