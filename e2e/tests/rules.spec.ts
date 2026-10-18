import type { Locator, Page } from "@playwright/test";
import { RUN_ID, expect, test, toastWith, uniqueName, type Api } from "./helpers.ts";

/**
 * Rules and Inspect.
 *
 * The rules and inspect API (GET /api/rules, PUT /api/rules/order, POST
 * /api/rules/preview, GET /api/inspect) is not served by every build yet.
 * Each test probes for it and skips with the reason while the server answers
 * the JSON 404, so this file turns itself on once the routes land.
 */

const RULES_MISSING = "the server does not serve /api/rules yet (rules routes not merged)";
const INSPECT_MISSING = "the server does not serve /api/inspect yet (inspect route not merged)";

/** The seeded default set, as shared/src/rules/defaults.ts declares it. */
const DEFAULT_RULE_NAMES = [
  "Global defaults",
  "Expire: subscriptions after 2 weeks",
  "Expire: watched after 2 months",
  "Expire: liked after 2 years",
  "Guard: no subscription backfill older than 7 days before install",
  "Captions: English only",
  "Keep unlisted and gone forever",
  "Notify when a video goes gone",
];

interface RuleBody {
  id: number;
  kind: "global" | "custom" | "video";
  name: string;
  position: number;
  condition: unknown;
  effects: Record<string, unknown>;
}

async function rules(api: Api): Promise<RuleBody[]> {
  return (await api.get<{ rows: RuleBody[] }>("/api/rules")).rows;
}

/** Custom rule names in list order (ascending position). */
async function customOrder(api: Api): Promise<string[]> {
  return (await rules(api))
    .filter((rule) => rule.kind === "custom")
    .sort((a, b) => a.position - b.position)
    .map((rule) => rule.name);
}

function customRow(page: Page, name: string): Locator {
  return page.getByTestId("custom-rule").filter({
    has: page.getByRole("button", { name, exact: true }),
  });
}

async function shownOrder(page: Page): Promise<string[]> {
  return page.getByTestId("custom-rule").getByTestId("rule-name").allTextContents();
}

/** PrimeVue Select: open it, then pick the option, which renders in an overlay. */
async function choose(page: Page, select: Locator, option: string): Promise<void> {
  await select.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function typeNumber(input: Locator, value: string): Promise<void> {
  await input.click();
  await input.press("ControlOrMeta+a");
  await input.pressSequentially(value);
  await input.press("Tab");
}

test.describe("rules", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ api }) => {
    test.skip(!(await api.has("/api/rules")), RULES_MISSING);
  });

  test.afterEach(async ({ api }) => {
    if (!(await api.has("/api/rules"))) return;
    for (const rule of await rules(api)) {
      if (rule.name.includes(`e2e-${RUN_ID}`)) {
        await api.send("DELETE", `/api/rules/${String(rule.id)}`, undefined, [200, 204, 404]);
      }
    }
  });

  test("the default rule set is seeded, with the global rule on top", async ({ page, api }) => {
    const rows = await rules(api);
    const seeded = rows.filter((rule) => DEFAULT_RULE_NAMES.includes(rule.name));
    expect(seeded).toHaveLength(DEFAULT_RULE_NAMES.length);
    expect(rows.filter((rule) => rule.kind === "global")).toHaveLength(1);
    expect(rows.find((rule) => rule.kind === "global")?.name).toBe("Global defaults");

    await page.goto("/rules");
    const global = page.getByTestId("global-rule");
    await expect(global.getByTestId("rule-name")).toHaveText("Global defaults");
    // The global rule cannot be moved or deleted.
    await expect(global.getByTestId("rule-up")).toHaveCount(0);
    await expect(global.getByTestId("rule-delete")).toHaveCount(0);

    const shown = await shownOrder(page);
    for (const name of DEFAULT_RULE_NAMES.slice(1)) {
      expect(shown.map((text) => text.trim())).toContain(name);
    }
    await expect(page.getByTestId("custom-rule")).toHaveCount(
      rows.filter((rule) => rule.kind === "custom").length,
    );
  });

  test("opening a rule shows its condition summary", async ({ page }) => {
    const name = "Expire: subscriptions after 2 weeks";
    await page.goto("/rules");
    const row = customRow(page, name);
    await expect(row.getByTestId("rule-summary")).not.toBeEmpty();

    await row.getByTestId("rule-edit").click();
    const drawer = page.getByTestId("rule-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText(`Edit rule: ${name}`);
    await expect(drawer.getByTestId("rule-editor").getByTestId("rule-name")).toHaveValue(name);
    await expect(drawer.getByTestId("condition-summary")).not.toBeEmpty();
    await expect(drawer.getByTestId("cond-leaf").first()).toBeVisible();
    await drawer.getByTestId("rule-cancel").click();
    await expect(drawer).toBeHidden();
  });

  test("a custom rule is built, previewed, reordered and deleted", async ({ page, api }) => {
    const name = uniqueName("Reclaim foo");
    await page.goto("/rules");
    await page.getByTestId("new-rule").click();
    const drawer = page.getByTestId("rule-drawer");
    await expect(drawer).toContainText("New rule");
    const editor = drawer.getByTestId("rule-editor");
    await editor.getByTestId("rule-name").fill(name);

    // Condition: channel name contains "foo".
    await editor.getByTestId("add-leaf").first().click();
    const leaf = editor.getByTestId("cond-leaf").first();
    await choose(page, leaf.getByTestId("leaf-field"), "Channel name");
    await choose(page, leaf.getByTestId("leaf-op"), "contains");
    await leaf.getByTestId("value-text").fill("foo");
    await expect(editor.getByTestId("condition-summary")).toContainText("foo");

    // Effect: reclaim priority 1.
    await choose(page, editor.getByTestId("effect-add"), "Reclaim priority");
    await typeNumber(editor.getByRole("spinbutton", { name: "Reclaim priority" }), "1");

    // Nothing is in the catalog, so the live preview matches nothing.
    await expect(drawer.getByTestId("preview-count")).toHaveText(/Matches\s+0\s+of\s+0/);

    await editor.getByTestId("rule-save").click();
    await expect(drawer).toBeHidden();
    await expect(toastWith(page, "Rule created")).toBeVisible();

    const row = customRow(page, name);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("rule-summary")).toContainText("foo");
    await expect(row.getByTestId("rule-chip").filter({ hasText: "Reclaim priority" })).toHaveText(
      /^Reclaim priority: .*\b1$/,
    );

    const created = (await rules(api)).find((rule) => rule.name === name);
    expect(created?.kind).toBe("custom");
    expect(created?.effects).toMatchObject({ reclaim_priority: 1 });

    // A new rule lands last (highest priority). Move it up one with the
    // keyboard-reachable button, then check the order survives a reload.
    const before = await customOrder(api);
    expect(before.at(-1)).toBe(name);
    await row.getByRole("button", { name: `Move ${name} up (lower priority)` }).focus();
    await page.keyboard.press("Enter");
    const expected = [...before.slice(0, -2), name, before.at(-2)!];
    await expect.poll(() => customOrder(api)).toEqual(expected);
    await page.reload();
    await expect
      .poll(async () => (await shownOrder(page)).map((text) => text.trim()))
      .toEqual(expected);
    await expect(customRow(page, name).getByTestId("rule-rank")).toHaveText(
      String(expected.length - 1),
    );

    // And back down again.
    await customRow(page, name)
      .getByRole("button", { name: `Move ${name} down (higher priority)` })
      .click();
    await expect.poll(() => customOrder(api)).toEqual(before);

    // Re-open it: the builder shows what was saved, and the preview still counts 0 of 0.
    await customRow(page, name).getByTestId("rule-edit").click();
    await expect(drawer.getByTestId("value-text").first()).toHaveValue("foo");
    await expect(drawer.getByTestId("preview-count")).toHaveText(/Matches\s+0\s+of\s+0/);
    await drawer.getByTestId("rule-cancel").click();

    await customRow(page, name).getByTestId("rule-delete").click();
    const confirm = page.getByRole("dialog", { name: "Delete rule" });
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(toastWith(page, "Rule deleted")).toBeVisible();
    await expect(customRow(page, name)).toHaveCount(0);
    await expect
      .poll(async () => (await rules(api)).some((rule) => rule.name === name))
      .toBe(false);
  });
});

test.describe("inspect", () => {
  const URL_INPUT = "https://youtu.be/dQw4w9WgXcQ?t=5";

  test("a pasted URL is normalised to its video id", async ({ page }) => {
    await page.goto("/inspect");
    const input = page.getByLabel("Video URL or id");
    await input.fill(URL_INPUT);
    await expect(page.getByTestId("inspect-parsed")).toHaveText(/Video id\s+dQw4w9WgXcQ/);
    await expect(page.getByTestId("inspect-submit")).toBeEnabled();

    await input.fill("https://example.com/not-a-video");
    await expect(page.getByTestId("inspect-invalid")).toBeVisible();
    await expect(page.getByTestId("inspect-submit")).toBeDisabled();
  });

  test("an unknown video shows the effective settings it would get", async ({ page, api }) => {
    test.skip(!(await api.has("/api/inspect?id=dQw4w9WgXcQ")), INSPECT_MISSING);

    await page.goto("/inspect");
    await page.getByLabel("Video URL or id").fill(URL_INPUT);
    await page.getByTestId("inspect-submit").click();

    const panel = page.getByTestId("inspect-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("inspect-known")).toHaveText("not in catalog");
    await expect(panel.getByTestId("inspect-unknown")).toBeVisible();
    const settings = panel.getByTestId("inspect-settings");
    await expect(settings).toBeVisible();
    await expect(settings.getByTestId("setting-value").first()).toBeVisible();
    // Every effective value says where it came from.
    const values = await settings.getByTestId("setting-value").count();
    expect(values).toBeGreaterThan(0);
    await expect(settings.getByTestId("setting-source")).toHaveCount(values);
  });
});
