import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import NotificationsPage from "../../src/pages/NotificationsPage.vue";
import { routes } from "../../src/router/index.ts";
import { useEventsStore } from "../../src/stores/events.ts";
import { useNotificationsStore } from "../../src/stores/notifications.ts";
import type { PushEnv } from "../../src/lib/push.ts";
import { flush } from "../helpers/dom.ts";
import { apiError, fakeServer, json, noContent, type FakeServer } from "../helpers/fakeServer.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { NOW, fakePush, makeNotification, paged } from "./fixtures.ts";

let pinia: Pinia;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

async function mountPage(fake: FakeServer, pushEnv: PushEnv = fakePush().env) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push("/notifications");
  await router.isReady();
  const wrapper = mount(NotificationsPage, {
    props: { pushEnv },
    global: mountGlobals({ api: fake.api, pinia, router }),
  });
  await flush();
  return wrapper;
}

function items(wrapper: VueWrapper) {
  return wrapper.findAll("[data-notification]");
}

function button(wrapper: VueWrapper, action: string) {
  return wrapper.find(`[data-action='${action}']`);
}

describe("Notifications inbox", () => {
  it("lists unread first, with type, title, body, age and a video link", async () => {
    const read = makeNotification({
      id: 2,
      title: "Older but newer read",
      created_at: NOW - 60_000,
      acked_at: NOW - 30_000,
    });
    const unread = makeNotification({
      id: 1,
      type: "video_gone",
      title: "A video is gone",
      video_id: "dQw4w9WgXcQ",
      created_at: NOW - 2 * 3_600_000,
    });
    const fake = fakeServer().on("GET", "/api/notifications", () => json(paged([read, unread])));
    const wrapper = await mountPage(fake);

    const list = items(wrapper);
    expect(list.map((item) => item.attributes("data-notification"))).toEqual(["1", "2"]);
    expect(list[0]!.text()).toContain("video_gone");
    expect(list[0]!.text()).toContain("A video is gone");
    expect(list[0]!.text()).toContain("2 h ago");
    expect(list[0]!.find("a").attributes("href")).toBe("/videos/dQw4w9WgXcQ");
    expect(list[0]!.find("[data-action='ack']").exists()).toBe(true);
    expect(list[1]!.find("[data-action='ack']").exists()).toBe(false);
    expect(list[1]!.text()).toContain("Acknowledged");
    expect(wrapper.find("[data-total]").text()).toBe("2 notifications");
  });

  it("acknowledges one notification and decrements the badge", async () => {
    const row = makeNotification({ id: 7 });
    const fake = fakeServer()
      .on("GET", "/api/notifications", () => json(paged([row])))
      .on("POST", "/api/notifications/7/ack", () => json({ ...row, acked_at: NOW }));
    const wrapper = await mountPage(fake);
    const badge = useNotificationsStore();
    badge.setUnread(4);

    await wrapper.find("[data-action='ack']").trigger("click");
    await flush();

    expect(fake.callsTo("POST", "/api/notifications/7/ack")).toHaveLength(1);
    expect(wrapper.find("[data-action='ack']").exists()).toBe(false);
    expect(badge.unread).toBe(3);
  });

  it("drops an acknowledged row from the unacknowledged-only view", async () => {
    const row = makeNotification({ id: 3 });
    const fake = fakeServer()
      .on("GET", "/api/notifications", () => json(paged([row])))
      .on("POST", "/api/notifications/3/ack", () => json({ ...row, acked_at: NOW }));
    const wrapper = await mountPage(fake);

    await wrapper.find("#notifications-unacked").setValue(true);
    await flush();
    const filtered = fake.callsTo("GET", "/api/notifications").at(-1)!;
    expect(filtered.query.get("unacked")).toBe("1");
    expect(filtered.query.get("page")).toBe("1");
    expect(useNotificationsStore().unread).toBe(1);

    await wrapper.find("[data-action='ack']").trigger("click");
    await flush();
    expect(items(wrapper)).toHaveLength(0);
    expect(wrapper.find(".empty-state h2").text()).toBe("Nothing unacknowledged");
  });

  it("keeps the row and toasts when acknowledging fails", async () => {
    const row = makeNotification({ id: 9 });
    const fake = fakeServer()
      .on("GET", "/api/notifications", () => json(paged([row])))
      .on("POST", "/api/notifications/9/ack", () => apiError(500, "boom"));
    const wrapper = await mountPage(fake);
    await wrapper.find("[data-action='ack']").trigger("click");
    await flush();
    expect(wrapper.find("[data-action='ack']").exists()).toBe(true);
  });

  it("acknowledges everything and reloads", async () => {
    let acked = false;
    const fake = fakeServer()
      .on("GET", "/api/notifications", () =>
        json(paged([makeNotification({ id: 1, acked_at: acked ? NOW : null })])),
      )
      .on("POST", "/api/notifications/ack-all", () => {
        acked = true;
        return noContent();
      });
    const wrapper = await mountPage(fake);
    useNotificationsStore().setUnread(1);

    await button(wrapper, "ack-all").trigger("click");
    await flush();

    expect(fake.callsTo("POST", "/api/notifications/ack-all")).toHaveLength(1);
    expect(fake.callsTo("GET", "/api/notifications")).toHaveLength(2);
    expect(useNotificationsStore().unread).toBe(0);
    expect(wrapper.find("[data-action='ack']").exists()).toBe(false);
    expect(button(wrapper, "ack-all").attributes("disabled")).toBeDefined();
  });

  it("shows the toast path when acknowledge-all fails", async () => {
    const fake = fakeServer()
      .on("GET", "/api/notifications", () => json(paged([makeNotification()])))
      .on("POST", "/api/notifications/ack-all", () => apiError(503, "not ready"));
    const wrapper = await mountPage(fake);
    await button(wrapper, "ack-all").trigger("click");
    await flush();
    expect(fake.callsTo("GET", "/api/notifications")).toHaveLength(1);
    expect(items(wrapper)).toHaveLength(1);
  });

  it("inserts a live notification at the top of the first page", async () => {
    const fake = fakeServer().on("GET", "/api/notifications", () =>
      json(paged([makeNotification({ id: 1, acked_at: NOW - 1000 })])),
    );
    const wrapper = await mountPage(fake);
    const events = useEventsStore();

    const live = makeNotification({ id: 42, title: "Fresh one", created_at: NOW });
    events.dispatch({ type: "notification", at: NOW, payload: live });
    await flush();
    expect(items(wrapper)[0]!.attributes("data-notification")).toBe("42");
    expect(wrapper.find("[data-total]").text()).toBe("2 notifications");

    // The same row again (a reconnect replay) is not duplicated.
    events.dispatch({ type: "notification", at: NOW, payload: live });
    // Unrelated events are ignored.
    events.dispatch({ type: "job.done", at: NOW, payload: { id: 1 } });
    await flush();
    expect(items(wrapper)).toHaveLength(2);
    expect(fake.callsTo("GET", "/api/notifications")).toHaveLength(1);
  });

  it("refetches when a live payload is not a full row", async () => {
    const fake = fakeServer().on("GET", "/api/notifications", () => json(paged([])));
    await mountPage(fake);
    useEventsStore().dispatch({ type: "notification", at: NOW, payload: { id: 5 } });
    await flush();
    expect(fake.callsTo("GET", "/api/notifications")).toHaveLength(2);
  });

  it("counts live arrivals while a later page is open, and jumps back on request", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => makeNotification({ id: i + 1 }));
    const fake = fakeServer().on("GET", "/api/notifications", (request) =>
      json(paged(rows, 60, Number(request.query.get("page") ?? "1"))),
    );
    const wrapper = await mountPage(fake);
    await wrapper.find("button[aria-label='Next Page']").trigger("click");
    await flush();
    expect(fake.callsTo("GET", "/api/notifications").at(-1)!.query.get("page")).toBe("2");

    useEventsStore().dispatch({ type: "notification", at: NOW, payload: makeNotification() });
    await flush();
    expect(wrapper.find("[data-pending]").text()).toContain("1 new notification");

    await wrapper.find("[data-pending] button").trigger("click");
    await flush();
    expect(fake.callsTo("GET", "/api/notifications").at(-1)!.query.get("page")).toBe("1");
    expect(wrapper.find("[data-pending]").exists()).toBe(false);
  });

  it("shows an empty state, and an error state that retries", async () => {
    let fail = true;
    const fake = fakeServer().on("GET", "/api/notifications", () =>
      fail ? apiError(500, "The server hit an unexpected error.") : json(paged([])),
    );
    const wrapper = await mountPage(fake);
    expect(wrapper.find(".error-state").exists()).toBe(true);
    fail = false;
    await wrapper.find(".error-state button").trigger("click");
    await flush();
    expect(wrapper.find(".error-state").exists()).toBe(false);
    expect(wrapper.find(".empty-state h2").text()).toBe("No notifications");
    expect(wrapper.find(".empty-state [data-icon='notifications']").exists()).toBe(true);
  });

  it("uses ASCII only in its copy", async () => {
    const fake = fakeServer().on("GET", "/api/notifications", () =>
      json(paged([makeNotification({ video_id: "abc" })])),
    );
    const wrapper = await mountPage(fake);
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(wrapper.text())).toBe(true);
  });
});

describe("Push panel", () => {
  function server() {
    return fakeServer()
      .on("GET", "/api/notifications", () => json(paged([])))
      .on("GET", "/api/notifications/vapid-public-key", () => json({ key: "AQID" }))
      .on("POST", "/api/notifications/subscribe", () => noContent())
      .on("DELETE", "/api/notifications/subscribe", () => noContent())
      .on("POST", "/api/notifications/test", () => noContent());
  }

  it("explains what to do when the browser cannot receive push", async () => {
    const push = fakePush();
    const wrapper = await mountPage(server(), { ...push.env, hasPushManager: false });
    expect(wrapper.find("[data-push-state]").text()).toBe("not supported");
    expect(wrapper.find("[data-push-unsupported]").text()).toContain("Add to Home Screen");
    expect(button(wrapper, "subscribe").exists()).toBe(false);
    expect(wrapper.text()).toContain("Cloudflare Access");
  });

  it("subscribes, shows the subscribed state, and unsubscribes", async () => {
    const push = fakePush();
    const fake = server();
    const wrapper = await mountPage(fake, push.env);
    expect(wrapper.find("[data-push-state]").text()).toBe("not subscribed");

    await button(wrapper, "subscribe").trigger("click");
    await flush();
    expect(push.subscribe).toHaveBeenCalledOnce();
    expect(fake.callsTo("POST", "/api/notifications/subscribe")).toHaveLength(1);
    expect(wrapper.find("[data-push-state]").text()).toBe("subscribed");

    await button(wrapper, "unsubscribe").trigger("click");
    await flush();
    expect(push.subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(fake.callsTo("DELETE", "/api/notifications/subscribe")).toHaveLength(1);
    expect(wrapper.find("[data-push-state]").text()).toBe("not subscribed");
  });

  it("starts in the subscribed state when the browser already has a subscription", async () => {
    const push = fakePush({ subscribed: true, permission: "granted" });
    const wrapper = await mountPage(server(), push.env);
    expect(wrapper.find("[data-push-state]").text()).toBe("subscribed");
    expect(button(wrapper, "unsubscribe").exists()).toBe(true);
  });

  it("reports a denied permission", async () => {
    const push = fakePush({ grant: "denied" });
    const wrapper = await mountPage(server(), push.env);
    await button(wrapper, "subscribe").trigger("click");
    await flush();
    expect(wrapper.find("[data-push-problem]").text()).toContain("blocked");
    expect(wrapper.find("[data-push-state]").text()).toBe("not subscribed");
  });

  it("reports a failure while reading the current subscription", async () => {
    const push = fakePush();
    push.register.mockRejectedValueOnce(new Error("Access session expired"));
    const wrapper = await mountPage(server(), push.env);
    expect(wrapper.find("[data-push-problem]").text()).toBe("Access session expired");
  });

  it("reports an unsubscribe failure", async () => {
    const push = fakePush({ subscribed: true, permission: "granted" });
    const fake = server().on("DELETE", "/api/notifications/subscribe", () => apiError(500, "x"));
    const wrapper = await mountPage(fake, push.env);
    await button(wrapper, "unsubscribe").trigger("click");
    await flush();
    expect(wrapper.find("[data-push-problem]").text()).toBe("x");
  });

  it("sends a test notification", async () => {
    const fake = server();
    const wrapper = await mountPage(fake);
    await button(wrapper, "test").trigger("click");
    await flush();
    expect(fake.callsTo("POST", "/api/notifications/test")).toHaveLength(1);

    fake.on("POST", "/api/notifications/test", () => apiError(500, "push failed"));
    await button(wrapper, "test").trigger("click");
    await flush();
    expect(fake.callsTo("POST", "/api/notifications/test")).toHaveLength(2);
  });
});
