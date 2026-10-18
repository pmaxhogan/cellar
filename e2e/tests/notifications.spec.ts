import type { Page } from "@playwright/test";
import { expect, test, toastWith, type Api } from "./helpers.ts";

/**
 * The inbox and the sidebar's unread badge. Other specs (and the boot
 * self-check) also create notifications, so nothing here assumes an absolute
 * count: rows are found by id and the badge is compared with the server.
 */

interface NotifyResult {
  sent: boolean;
  id: number;
}

/** The badge text the shell should show for the server's current unread count. */
async function expectedBadge(api: Api): Promise<string> {
  const unread = await api.unreadCount();
  if (unread === 0) return "";
  return unread > 99 ? "99+" : String(unread);
}

async function badgeText(page: Page): Promise<string> {
  const badge = page.locator("[data-unread-badge]");
  if ((await badge.count()) === 0) return "";
  // The badge reads "<n> unread" to a screen reader; the visible part is the number.
  return ((await badge.textContent()) ?? "").replace("unread", "").trim();
}

test("a test notification shows in the inbox and acknowledging it updates the badge", async ({
  page,
  api,
}) => {
  const sent = await api.send<NotifyResult>("POST", "/api/notifications/test");
  expect(sent.sent).toBe(true);

  await page.goto("/notifications");
  const item = page.locator(`[data-notification="${String(sent.id)}"]`);
  await expect(item).toBeVisible();
  await expect(item).toContainText("Test notification");
  await expect(item.getByLabel("Unread")).toHaveCount(1);
  await expect.poll(() => badgeText(page)).toBe(await expectedBadge(api));
  const before = await api.unreadCount();
  expect(before).toBeGreaterThan(0);

  await item.locator('[data-action="ack"]').click();
  await expect(item.locator('[data-action="ack"]')).toHaveCount(0);
  await expect(item).toContainText("Acknowledged");
  await expect.poll(() => api.unreadCount()).toBeLessThan(before);
  await expect.poll(() => badgeText(page)).toBe(await expectedBadge(api));

  // The acknowledgement is stored, not just drawn.
  await page.reload();
  await expect(item).toContainText("Acknowledged");
  await expect(item.locator('[data-action="ack"]')).toHaveCount(0);
});

test("a notification sent while the inbox is open arrives live", async ({ page, api }) => {
  await page.goto("/notifications");
  await expect(page.locator("[data-total]")).toBeVisible();
  // The live stream has to be up before the event is sent, or it is missed.
  await expect(page.getByTestId("status-pill")).toHaveAttribute("title", "Live updates connected");

  const sent = await api.send<NotifyResult>("POST", "/api/notifications/test");
  const item = page.locator(`[data-notification="${String(sent.id)}"]`);
  await expect(item).toBeVisible();
  await expect.poll(() => badgeText(page)).toBe(await expectedBadge(api));
});

test("acknowledge all clears the badge", async ({ page, api }) => {
  await api.send("POST", "/api/notifications/test");
  await page.goto("/notifications");
  await expect(page.locator("[data-unread-badge]")).toBeVisible();

  await page.locator('[data-action="ack-all"]').click();
  await expect(toastWith(page, "All notifications acknowledged")).toBeVisible();
  await expect(page.locator("[data-unread-badge]")).toHaveCount(0);
  expect(await api.unreadCount()).toBe(0);

  await page.getByLabel("Unacknowledged only").check();
  await expect(page.getByText("Nothing unacknowledged")).toBeVisible();
});

test("the push panel settles on a state the browser can explain", async ({ page }) => {
  await page.goto("/notifications");
  const panel = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Push notifications" }),
  });
  await expect(panel).toBeVisible();
  // Headless Chromium on plain-http loopback may or may not expose Web Push;
  // either way the panel must leave "checking" and say which it is.
  const state = panel.locator("[data-push-state]");
  await expect(state).toHaveText(/^(not supported|not subscribed|subscribed)$/);
  if ((await state.textContent()) === "not supported") {
    await expect(panel.locator("[data-push-unsupported]")).toBeVisible();
  } else {
    await expect(
      panel.locator('[data-action="subscribe"], [data-action="unsubscribe"]'),
    ).toHaveCount(1);
  }

  // The test button sends through the server whatever the browser supports.
  await panel.locator('[data-action="test"]').click();
  await expect(toastWith(page, "Test notification sent")).toBeVisible();
});
