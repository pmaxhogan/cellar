import { expect, test } from "./helpers.ts";

/**
 * The shell every page sits in, and the parts of the public surface that are
 * not the admin app: the share 404, the privacy page, healthz and status.
 */

/** Sidebar order, as web/src/router/index.ts NAV_LINKS declares it. */
const NAV: { label: string; path: string; heading: string }[] = [
  { label: "Videos", path: "/", heading: "Videos" },
  { label: "Title changes", path: "/title-changes", heading: "Title changes" },
  { label: "Inspect", path: "/inspect", heading: "Inspect" },
  { label: "Rules", path: "/rules", heading: "Rules" },
  { label: "Accounts", path: "/accounts", heading: "Accounts" },
  { label: "Channels", path: "/channels", heading: "Channels" },
  { label: "Takeout", path: "/takeout", heading: "Takeout" },
  { label: "Locations", path: "/locations", heading: "Locations" },
  { label: "Proxies", path: "/proxies", heading: "Proxies" },
  { label: "Share links", path: "/shares", heading: "Share links" },
  { label: "Activity", path: "/activity", heading: "Activity" },
  { label: "Notifications", path: "/notifications", heading: "Notifications" },
  { label: "Self-check", path: "/self-check", heading: "Self-check" },
  { label: "Charts", path: "/charts", heading: "Charts" },
  { label: "Settings", path: "/settings", heading: "Settings" },
  { label: "About", path: "/about", heading: "About" },
];

test("loads the app with the insecure banner", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Cellar/);
  // The one thing that must never be missable when auth is switched off.
  const banner = page.getByRole("alert").filter({ hasText: "INSECURE MODE" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("authentication is disabled");
});

test("sidebar links match the route table and every page renders", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  const links = nav.getByRole("link");
  await expect(links).toHaveCount(NAV.length);

  for (const [index, entry] of NAV.entries()) {
    const link = links.nth(index);
    // The notifications link also carries the unread badge, so match the start.
    await expect(link).toHaveText(new RegExp(`^${entry.label}`));
    await expect(link).toHaveAttribute("href", entry.path);
  }

  for (const entry of NAV) {
    await nav.getByRole("link", { name: new RegExp(`^${entry.label}`) }).click();
    await expect(page).toHaveURL((url) => url.pathname === entry.path);
    await expect(page.getByRole("heading", { level: 1, name: entry.heading })).toBeVisible();
    // The banner is part of the shell, not of one page.
    await expect(page.getByRole("alert").filter({ hasText: "INSECURE MODE" })).toBeVisible();
  }
});

test("an unknown admin route falls back to the videos page", async ({ page }) => {
  await page.goto("/no-such-page");
  await expect(page).toHaveURL((url) => url.pathname === "/");
});

test("the theme toggle persists across a reload", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  const toggle = page.getByRole("button", { name: /Switch to (light|dark) mode/ });

  // Dark by default, unless something stored light.
  await page.evaluate(() => localStorage.removeItem("cellar.color-scheme"));
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(html).toHaveClass(/cellar-dark/);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toHaveAccessibleName("Switch to dark mode");
  await expect(html).not.toHaveClass(/cellar-dark/);
  expect(await page.evaluate(() => localStorage.getItem("cellar.color-scheme"))).toBe("light");

  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(html).not.toHaveClass(/cellar-dark/);

  await toggle.click();
  await expect(html).toHaveClass(/cellar-dark/);
  expect(await page.evaluate(() => localStorage.getItem("cellar.color-scheme"))).toBe("dark");
});

test("the status pill reflects /api/status and About shows the version", async ({ page, api }) => {
  const status = await api.status();
  expect(status.insecureMode).toBe(true);
  expect(status.db.ok).toBe(true);
  expect(status.version).toMatch(/^\d+\.\d+\.\d+/);

  await page.goto("/");
  const pill = page.getByTestId("status-pill");
  await expect(pill).toBeVisible();
  // The pill is a one-phrase health summary, not a version string. It must
  // leave "connecting" and must not be the error state.
  const missing = [
    ...(status.tools.ytdlp === null ? ["yt-dlp"] : []),
    ...(status.tools.ffmpeg === null ? ["ffmpeg"] : []),
  ];
  const expected = missing.length === 0 ? "ready" : `${missing.join(", ")} missing`;
  // The live region is the summary; the rest of the pill is screen reader text.
  await expect(pill.locator('[aria-live="polite"]')).toHaveText(expected);
  await expect(pill).toHaveAttribute("title", /Live updates/);

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "About" }).click();
  await expect(page.locator('[data-fact="version"]')).toHaveAttribute("title", status.version);
  await expect(page.locator('[data-fact="version"]')).toContainText(status.version);
});

test("healthz and status answer", async ({ request }) => {
  const health = await request.get("/healthz");
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ ok: true });

  const status = await request.get("/api/status");
  expect(status.status()).toBe(200);
  expect(status.headers()["content-type"]).toContain("application/json");

  // An API typo stays a JSON 404 and is never answered with the SPA.
  const typo = await request.get("/api/definitely-not-a-route");
  expect(typo.status()).toBe(404);
  expect(await typo.json()).toMatchObject({ code: "not_found" });
});

test("an unknown share token answers 404 with the share not-found page", async ({
  page,
  request,
}) => {
  const response = await request.get("/s/nope");
  expect(response.status()).toBe(404);
  expect(response.headers()["x-robots-tag"]).toContain("noindex");
  expect(response.headers()["content-type"]).toContain("text/html");
  // The public bundle, never the admin shell.
  const html = await response.text();
  expect(html).toContain("/s/assets/");
  expect(html).not.toContain("INSECURE MODE");

  const navigation = await page.goto("/s/nope");
  expect(navigation?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "Not found" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
});

test("the privacy page is public", async ({ page, request }) => {
  const response = await request.get("/s/privacy");
  expect(response.status()).toBe(200);
  expect(response.headers()["x-robots-tag"]).toContain("noindex");

  await page.goto("/s/privacy");
  await expect(page).toHaveTitle(/Privacy/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
