import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import NotificationItem from "../../src/components/notifications/NotificationItem.vue";
import PushPanel from "../../src/components/notifications/PushPanel.vue";
import NotificationsPage from "../../src/pages/NotificationsPage.vue";
import { browserPushEnv } from "../../src/lib/push.ts";
import { routes } from "../../src/router/index.ts";
import { flush } from "../helpers/dom.ts";
import { fakeServer, json, type FakeServer } from "../helpers/fakeServer.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { fakePush, makeNotification, paged } from "./fixtures.ts";

let pinia: Pinia;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function withRouter() {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push("/notifications");
  await router.isReady();
  return router;
}

describe("NotificationItem", () => {
  it("colours the type badge by what the type says", async () => {
    const router = await withRouter();
    const cases: [string, string][] = [
      ["auth_lost", "p-tag-danger"],
      ["storage_pressure", "p-tag-warn"],
      ["rule_notify", "p-tag-info"],
      ["something_else", "p-tag-secondary"],
    ];
    for (const [type, cls] of cases) {
      const wrapper = mount(NotificationItem, {
        props: { row: makeNotification({ type, pushed_at: 1 }) },
        global: mountGlobals({ pinia, router }),
      });
      expect(wrapper.find(".p-tag").classes()).toContain(cls);
      expect(wrapper.text()).toContain("Pushed");
    }
  });
});

describe("Notifications page edges", () => {
  async function mountPage(fake: FakeServer) {
    const router = await withRouter();
    const wrapper = mount(NotificationsPage, {
      props: { pushEnv: fakePush().env },
      global: mountGlobals({ api: fake.api, pinia, router }),
    });
    await flush();
    return wrapper;
  }

  it("drops a superseded load when the filter flips mid-flight, and stops on unmount", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeServer().on("GET", "/api/notifications", async () => {
      calls += 1;
      if (calls === 1) {
        await gate;
        return json(paged([makeNotification({ id: 1, title: "stale" })]));
      }
      return json(paged([makeNotification({ id: 2, title: "fresh" })]));
    });
    const wrapper = await mountPage(fake);
    await wrapper.find("#notifications-unacked").setValue(true);
    await flush();
    release();
    await flush();
    expect(wrapper.text()).toContain("fresh");
    expect(wrapper.text()).not.toContain("stale");
    expect(wrapper.find(".error-state").exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("Push panel edges", () => {
  it("works without a Notification API and explains an unknown failure", async () => {
    const push = fakePush();
    push.register.mockRejectedValueOnce("weird");
    const wrapper = mount(PushPanel, {
      props: { env: { ...push.env, notification: undefined } },
      global: mountGlobals({ pinia }),
    });
    await flush();
    expect(wrapper.find("[data-push-problem]").text()).toBe(
      "The browser refused the push subscription.",
    );
  });

  it("warns when the site's notifications are blocked", async () => {
    const push = fakePush({ permission: "denied", subscribed: false });
    const wrapper = mount(PushPanel, { props: { env: push.env }, global: mountGlobals({ pinia }) });
    await flush();
    expect(wrapper.text()).toContain("Notifications are blocked for this site.");
  });

  it("reads Notification from the browser", () => {
    const fake = { permission: "default", requestPermission: vi.fn() };
    vi.stubGlobal("Notification", fake);
    expect(browserPushEnv().notification).toBe(fake);
  });
});
