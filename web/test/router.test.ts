import { describe, expect, it } from "vitest";
import { NAV_LINKS, routes } from "../src/router/index.ts";

const ICONS_WITH_PATHS = [
  "videos",
  "titles",
  "inspect",
  "rules",
  "accounts",
  "channels",
  "folder",
  "locations",
  "proxies",
  "shares",
  "activity",
  "notifications",
  "selfcheck",
  "charts",
  "settings",
  "about",
];

describe("router config", () => {
  it("uses the Videos page as the default route", () => {
    expect(routes[0]?.path).toBe("/");
    expect(routes[0]?.name).toBe("videos");
  });

  it("has a nav link for every named page route without a parameter, in order", () => {
    const pagePaths = routes
      .filter((route) => route.name !== undefined && !route.path.includes(":"))
      .map((route) => route.path);
    expect(NAV_LINKS.map((link) => link.to)).toEqual(pagePaths);
  });

  it("lists the admin pages in the spec's nav order", () => {
    expect(NAV_LINKS.map((link) => link.label)).toEqual([
      "Videos",
      "Title changes",
      "Inspect",
      "Rules",
      "Accounts",
      "Channels",
      "Takeout",
      "Locations",
      "Proxies",
      "Share links",
      "Activity",
      "Notifications",
      "Self-check",
      "Charts",
      "Settings",
      "About",
    ]);
  });

  it("titles each route the same as its nav label", () => {
    for (const link of NAV_LINKS) {
      const route = routes.find((candidate) => candidate.path === link.to);
      expect(route?.meta?.title).toBe(link.label);
    }
  });

  it("uses only icons AppIcon draws", () => {
    for (const link of NAV_LINKS) expect(ICONS_WITH_PATHS).toContain(link.icon);
  });

  it("has a video detail route reached from a page, not the sidebar", () => {
    const detail = routes.find((route) => route.name === "video");
    expect(detail?.path).toBe("/videos/:id");
    expect(NAV_LINKS.some((link) => link.to.startsWith("/videos"))).toBe(false);
  });

  it("never claims /s, which belongs to the public share page", () => {
    for (const route of routes) {
      expect(route.path === "/s" || route.path.startsWith("/s/")).toBe(false);
    }
  });

  it("catches unknown paths and redirects home", () => {
    const fallback = routes[routes.length - 1];
    expect(fallback?.path).toBe("/:pathMatch(.*)*");
    expect(fallback?.redirect).toBe("/");
  });

  it("lazy-loads every page but the landing one, and each resolves", async () => {
    for (const route of routes.slice(1)) {
      if (route.redirect !== undefined) continue;
      expect(typeof route.component).toBe("function");
      const loader = route.component as () => Promise<{ default: unknown }>;
      const loaded = await loader();
      expect(loaded.default).toBeTruthy();
    }
  });
});
