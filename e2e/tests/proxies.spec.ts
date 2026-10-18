import type { Locator, Page } from "@playwright/test";
import { expect, test, toastWith, uniqueName } from "./helpers.ts";

/**
 * The proxy pool. URLs are write-only: the credentials go in once and only a
 * redacted form ever comes back, in the API and in the page.
 */

// Port 1 on loopback refuses at once, so the reachability test fails fast.
const SECRET_USER = "e2euser";
const SECRET_PASSWORD = "e2e-pw-s3cret";
const BOGUS_URL = `http://${SECRET_USER}:${SECRET_PASSWORD}@127.0.0.1:1`;

function proxyRow(page: Page, label: string): Locator {
  return page.getByRole("row").filter({ hasText: label });
}

test.afterEach(async ({ api }) => {
  await api.deleteOwned("proxies");
});

test("a proxy is added redacted, fails its test, is renamed and deleted", async ({ page, api }) => {
  const label = uniqueName("Bogus proxy");
  const renamed = uniqueName("Renamed proxy");

  await page.goto("/proxies");
  await page.locator('[data-action="add-proxy"]').click();
  const dialog = page.getByRole("dialog", { name: "Add proxy" });
  await dialog.getByLabel("Label").fill(label);
  const urlInput = dialog.getByLabel("Proxy URL");
  // A password field: the URL is not echoed on screen even while typing.
  await expect(urlInput).toHaveAttribute("type", "password");
  await urlInput.fill(BOGUS_URL);
  await dialog.locator('[data-action="save-proxy"]').click();
  await expect(dialog).toBeHidden();
  await expect(toastWith(page, "Proxy added")).toBeVisible();

  const row = proxyRow(page, label);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("url-redacted")).toHaveText("http://127.0.0.1:1");
  await expect(row.getByTestId("enabled")).toHaveText("Enabled");

  // Neither the rendered page nor the API ever carries the credentials.
  const html = await page.content();
  expect(html).not.toContain(SECRET_PASSWORD);
  expect(html).not.toContain(SECRET_USER);
  const listed = await api.request.get("/api/proxies");
  const body = await listed.text();
  expect(body).not.toContain(SECRET_PASSWORD);
  expect(body).not.toContain(SECRET_USER);

  await row.locator('[data-action="test"]').click();
  await expect(row.getByTestId("test-result")).toHaveText(/^Failed/);
  await expect(toastWith(page, `${label} failed`)).toBeVisible();

  await row.locator('[data-action="edit"]').click();
  const edit = page.getByRole("dialog", { name: "Edit proxy" });
  // An empty URL field keeps the stored URL; the hint shows only the redacted form.
  await expect(edit).toContainText("Currently http://127.0.0.1:1");
  await expect(edit.getByLabel("Proxy URL")).toHaveValue("");
  await edit.getByLabel("Label").fill(renamed);
  await edit.locator('[data-action="save-proxy"]').click();
  await expect(edit).toBeHidden();
  await expect(toastWith(page, "Proxy saved")).toBeVisible();
  const renamedRow = proxyRow(page, renamed);
  await expect(renamedRow).toBeVisible();
  await expect(renamedRow.getByTestId("url-redacted")).toHaveText("http://127.0.0.1:1");

  await page.reload();
  await expect(proxyRow(page, renamed)).toBeVisible();
  await expect(proxyRow(page, label)).toHaveCount(0);

  await proxyRow(page, renamed).locator('[data-action="toggle"]').click();
  await expect(proxyRow(page, renamed).getByTestId("enabled")).toHaveText("Disabled");

  await proxyRow(page, renamed).locator('[data-action="remove"]').click();
  const confirm = page.getByRole("dialog", { name: "Delete proxy?" });
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(confirm).toBeHidden();
  await expect(proxyRow(page, renamed)).toHaveCount(0);
  await expect
    .poll(async () => (await api.proxies()).some((proxy) => proxy.label === renamed))
    .toBe(false);
});

test("a URL without a scheme is rejected in the form", async ({ page }) => {
  await page.goto("/proxies");
  await page.locator('[data-action="add-proxy"]').click();
  const dialog = page.getByRole("dialog", { name: "Add proxy" });
  await dialog.getByLabel("Label").fill(uniqueName("Bad proxy"));
  await dialog.getByLabel("Proxy URL").fill("not a url");
  await dialog.locator('[data-action="save-proxy"]').click();
  await expect(dialog.getByTestId("url-error")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});
