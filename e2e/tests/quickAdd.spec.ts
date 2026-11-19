import type { Page } from "@playwright/test";
import { expect, test } from "./helpers.ts";

/**
 * The Quick add page in a real browser: the focus rules and the paste rules
 * are the whole point of the page, and jsdom only approximates both.
 *
 * Videos cannot be deleted through the API, so every test uses ids no other
 * spec knows (random, 11 id characters) and leaves its rows behind.
 */

function randomVideoId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let index = 0; index < 11; index += 1) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return id;
}

/**
 * A paste as the browser delivers it: a ClipboardEvent carrying plain text.
 * The script is a string because this workspace compiles without the DOM lib.
 */
async function paste(page: Page, text: string): Promise<void> {
  await page.evaluate(`(() => {
    const data = new DataTransfer();
    data.setData("text/plain", ${JSON.stringify(text)});
    document
      .querySelector("[data-test='quick-input']")
      .dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
  })()`);
}

test("is the first sidebar link and focuses its field on load", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link").first()).toHaveText("Quick add");
  await nav.getByRole("link", { name: "Quick add" }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/quick-add");
  await expect(page.getByTestId("quick-input")).toBeFocused();
});

test("Enter adds the video, clears the field and keeps the focus", async ({ page, request }) => {
  const id = randomVideoId();
  await page.goto("/quick-add");
  const input = page.getByTestId("quick-input");
  await expect(input).toBeFocused();
  await page.keyboard.type(`https://youtu.be/${id}?t=5`);
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  const entry = page.getByTestId("quick-entry").first();
  await expect(entry).toHaveAttribute("data-state", "ok");
  await expect(entry.getByTestId("quick-message")).toContainText("Added.");
  await expect(entry.getByRole("link")).toHaveAttribute("href", `/videos/${id}`);

  // Pinned by a video rule that keeps it forever; the other rules still match.
  const inspect = (await (await request.get(`/api/inspect?id=${id}`)).json()) as {
    known: boolean;
    overrides: Record<string, unknown>;
    matched: { kind: string }[];
  };
  expect(inspect.known).toBe(true);
  expect(inspect.overrides).toMatchObject({ include: true, reclaim_priority: -1 });
  expect(inspect.matched.map((rule) => rule.kind)).toContain("global");

  // The Add button does the same and hands the focus back.
  const second = randomVideoId();
  await page.keyboard.type(second);
  await page.getByTestId("quick-submit").click();
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(page.getByTestId("quick-entry")).toHaveCount(2);

  await page.keyboard.type("not a video");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("quick-entry").first()).toHaveAttribute("data-state", "error");
  await expect(input).toBeFocused();
});

test("pasting several links adds all but the last, or all with a trailing new line", async ({
  page,
}) => {
  const [a, b, c, d, e] = [1, 2, 3, 4, 5].map(() => randomVideoId());
  await page.goto("/quick-add");
  const input = page.getByTestId("quick-input");
  const entries = page.getByTestId("quick-entry");

  await paste(page, `${String(a)}\nhttps://youtu.be/${String(b)}\n${String(c)}`);
  await expect(entries).toHaveCount(2);
  await expect(input).toHaveValue(String(c));

  // Pasting over the held link confirms it and holds the new one.
  await paste(page, String(d));
  await expect(entries).toHaveCount(3);
  await expect(input).toHaveValue(String(d));

  // A trailing new line confirms everything, the held link included.
  await paste(page, `${String(e)}\n`);
  await expect(entries).toHaveCount(5);
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(page.locator("[data-test='quick-entry'][data-state='ok']")).toHaveCount(5);
  const links = entries.getByRole("link");
  await expect(links.first()).toHaveAttribute("href", `/videos/${String(e)}`);
  await expect(links.last()).toHaveAttribute("href", `/videos/${String(a)}`);
});
