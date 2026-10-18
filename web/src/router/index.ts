import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import VideosPage from "../pages/VideosPage.vue";

/**
 * Videos is the landing route, so it is bundled eagerly. Every other page is a
 * dynamic import: the rule builder, the charts and the datatables each pull in
 * PrimeVue components nobody needs to download to look at the video list.
 *
 * Page routes are named; the order of the nav entries below is the sidebar
 * order. Routes with a path parameter (video detail) are reached from a page,
 * never from the sidebar.
 */
export const routes: RouteRecordRaw[] = [
  { path: "/", name: "videos", component: VideosPage, meta: { title: "Videos" } },
  {
    path: "/videos/:id",
    name: "video",
    component: () => import("../pages/VideoPage.vue"),
    meta: { title: "Video" },
  },
  {
    path: "/inspect",
    name: "inspect",
    component: () => import("../pages/InspectPage.vue"),
    meta: { title: "Inspect" },
  },
  {
    path: "/rules",
    name: "rules",
    component: () => import("../pages/RulesPage.vue"),
    meta: { title: "Rules" },
  },
  {
    path: "/accounts",
    name: "accounts",
    component: () => import("../pages/AccountsPage.vue"),
    meta: { title: "Accounts" },
  },
  {
    path: "/channels",
    name: "channels",
    component: () => import("../pages/ChannelsPage.vue"),
    meta: { title: "Channels" },
  },
  {
    path: "/takeout",
    name: "takeout",
    component: () => import("../pages/TakeoutPage.vue"),
    meta: { title: "Takeout" },
  },
  {
    path: "/locations",
    name: "locations",
    component: () => import("../pages/LocationsPage.vue"),
    meta: { title: "Locations" },
  },
  {
    path: "/proxies",
    name: "proxies",
    component: () => import("../pages/ProxiesPage.vue"),
    meta: { title: "Proxies" },
  },
  {
    path: "/shares",
    name: "shares",
    component: () => import("../pages/SharesPage.vue"),
    meta: { title: "Share links" },
  },
  {
    path: "/activity",
    name: "activity",
    component: () => import("../pages/ActivityPage.vue"),
    meta: { title: "Activity" },
  },
  {
    path: "/notifications",
    name: "notifications",
    component: () => import("../pages/NotificationsPage.vue"),
    meta: { title: "Notifications" },
  },
  {
    path: "/self-check",
    name: "self-check",
    component: () => import("../pages/SelfCheckPage.vue"),
    meta: { title: "Self-check" },
  },
  {
    path: "/charts",
    name: "charts",
    component: () => import("../pages/ChartsPage.vue"),
    meta: { title: "Charts" },
  },
  {
    path: "/settings",
    name: "settings",
    component: () => import("../pages/SettingsPage.vue"),
    meta: { title: "Settings" },
  },
  {
    path: "/about",
    name: "about",
    component: () => import("../pages/AboutPage.vue"),
    meta: { title: "About" },
  },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

export interface NavLink {
  to: string;
  label: string;
  /** AppIcon name. */
  icon: string;
}

/** Sidebar navigation, in display order. */
export const NAV_LINKS: NavLink[] = [
  { to: "/", label: "Videos", icon: "videos" },
  { to: "/inspect", label: "Inspect", icon: "inspect" },
  { to: "/rules", label: "Rules", icon: "rules" },
  { to: "/accounts", label: "Accounts", icon: "accounts" },
  { to: "/channels", label: "Channels", icon: "channels" },
  { to: "/takeout", label: "Takeout", icon: "folder" },
  { to: "/locations", label: "Locations", icon: "locations" },
  { to: "/proxies", label: "Proxies", icon: "proxies" },
  { to: "/shares", label: "Share links", icon: "shares" },
  { to: "/activity", label: "Activity", icon: "activity" },
  { to: "/notifications", label: "Notifications", icon: "notifications" },
  { to: "/self-check", label: "Self-check", icon: "selfcheck" },
  { to: "/charts", label: "Charts", icon: "charts" },
  { to: "/settings", label: "Settings", icon: "settings" },
  { to: "/about", label: "About", icon: "about" },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
