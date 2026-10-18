/* global self, clients */
/**
 * Cellar service worker: Web Push only. No fetch handler and no caching, so
 * the admin app always talks to the network (and to Cloudflare Access).
 *
 * The push payload is the JSON the server sends: { title, body, data } where
 * data may carry a `url` to open on click. Served from /sw.js unchanged (see
 * web/vite.config.ts), because a worker's scope is its script's directory.
 */

const DEFAULT_URL = "/notifications";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  if (!payload || typeof payload !== "object") payload = {};
  const title =
    typeof payload.title === "string" && payload.title !== "" ? payload.title : "Cellar";
  const data = payload.data && typeof payload.data === "object" ? { ...payload.data } : {};
  const videoId = typeof payload.video_id === "string" ? payload.video_id : data.video_id;
  if (typeof data.url !== "string" && typeof videoId === "string" && videoId !== "") {
    data.url = `/videos/${encodeURIComponent(videoId)}`;
  }
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof payload.body === "string" ? payload.body : "",
      data,
      icon: "/favicon.svg",
      tag: typeof payload.tag === "string" ? payload.tag : undefined,
    }),
  );
});

/** Only same-origin targets: a payload must never send the user elsewhere. */
function clickTarget(data) {
  const fallback = new URL(DEFAULT_URL, self.location.origin).href;
  if (!data || typeof data.url !== "string" || data.url === "") return fallback;
  try {
    const url = new URL(data.url, self.location.origin);
    return url.origin === self.location.origin ? url.href : fallback;
  } catch {
    return fallback;
  }
}

async function openTarget(target) {
  const list = await clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of list) {
    if (client.url === target && "focus" in client) return client.focus();
  }
  for (const client of list) {
    if ("navigate" in client && "focus" in client) {
      try {
        const navigated = await client.navigate(target);
        return (navigated || client).focus();
      } catch {
        break;
      }
    }
  }
  return clients.openWindow(target);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openTarget(clickTarget(event.notification.data)));
});
