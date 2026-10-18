import { describe, expect, it, vi } from "vitest";
import SOURCE from "../../public/sw.js?raw";

/**
 * public/sw.js is plain JavaScript served as-is, so it is exercised here by
 * evaluating its own source (a repo file, never external input) against a
 * fake worker global.
 */
const ORIGIN = "https://cellar.example";

interface FakeClient {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  navigate?: ReturnType<typeof vi.fn>;
}

function loadWorker(clientList: FakeClient[] = []) {
  const handlers = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(null);
  const clients = {
    matchAll: vi.fn().mockResolvedValue(clientList),
    openWindow,
    claim: vi.fn().mockResolvedValue(undefined),
  };
  const self = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      handlers.set(type, handler);
    },
    skipWaiting: vi.fn(),
    clients,
    registration: { showNotification },
    location: { origin: ORIGIN },
  };
  new Function("self", "clients", SOURCE)(self, clients);

  async function fire(type: string, extra: Record<string, unknown> = {}): Promise<void> {
    const pending: Promise<unknown>[] = [];
    handlers.get(type)!({ waitUntil: (p: Promise<unknown>) => pending.push(p), ...extra });
    await Promise.all(pending);
  }

  function push(data: unknown) {
    return fire("push", {
      data:
        data === undefined
          ? null
          : {
              json: () => (typeof data === "string" ? JSON.parse(data) : data),
              text: () => String(data),
            },
    });
  }

  function click(data: unknown) {
    const close = vi.fn();
    return fire("notificationclick", { notification: { data, close } }).then(() => close);
  }

  return { handlers, showNotification, openWindow, clients, self, fire, push, click };
}

describe("service worker", () => {
  it("activates at once and claims open pages", async () => {
    const worker = loadWorker();
    await worker.fire("install");
    expect(worker.self.skipWaiting).toHaveBeenCalledOnce();
    await worker.fire("activate");
    expect(worker.clients.claim).toHaveBeenCalledOnce();
  });

  it("shows the pushed title, body and data with the cellar icon", async () => {
    const worker = loadWorker();
    await worker.push({
      title: "Downloads failing",
      body: "3 in a row",
      data: { url: "/activity" },
    });
    expect(worker.showNotification).toHaveBeenCalledWith("Downloads failing", {
      body: "3 in a row",
      data: { url: "/activity" },
      icon: "/favicon.svg",
      tag: undefined,
    });
  });

  it("falls back to a default title, and links a video when only its id is sent", async () => {
    const worker = loadWorker();
    await worker.push({ body: "gone", video_id: "abc" });
    const [title, options] = worker.showNotification.mock.calls[0]!;
    expect(title).toBe("Cellar");
    expect(options.data).toEqual({ url: "/videos/abc" });
  });

  it("survives an empty, null or non-JSON push", async () => {
    const worker = loadWorker();
    await worker.push(undefined);
    await worker.push("null");
    await worker.fire("push", {
      data: {
        json: () => {
          throw new SyntaxError("bad");
        },
        text: () => "plain text",
      },
    });
    expect(worker.showNotification.mock.calls.map((call) => call[0])).toEqual([
      "Cellar",
      "Cellar",
      "Cellar",
    ]);
    expect(worker.showNotification.mock.calls[2]![1].body).toBe("plain text");
  });

  it("focuses a tab already on the target", async () => {
    const tab = { url: `${ORIGIN}/videos/abc`, focus: vi.fn() };
    const worker = loadWorker([tab]);
    const close = await worker.click({ url: "/videos/abc" });
    expect(close).toHaveBeenCalledOnce();
    expect(tab.focus).toHaveBeenCalledOnce();
    expect(worker.openWindow).not.toHaveBeenCalled();
  });

  it("navigates another open tab to the inbox by default", async () => {
    const focus = vi.fn();
    const tab = {
      url: `${ORIGIN}/`,
      focus: vi.fn(),
      navigate: vi.fn().mockResolvedValue({ focus }),
    };
    const worker = loadWorker([tab]);
    await worker.click(null);
    expect(tab.navigate).toHaveBeenCalledWith(`${ORIGIN}/notifications`);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("opens a window when no tab can be used, and never leaves the origin", async () => {
    const tab = {
      url: `${ORIGIN}/`,
      focus: vi.fn(),
      navigate: vi.fn().mockRejectedValue(new TypeError("uncontrolled")),
    };
    const worker = loadWorker([tab]);
    await worker.click({ url: "https://evil.example/phish" });
    expect(worker.openWindow).toHaveBeenCalledWith(`${ORIGIN}/notifications`);

    const empty = loadWorker();
    await empty.click({ url: "/self-check" });
    expect(empty.openWindow).toHaveBeenCalledWith(`${ORIGIN}/self-check`);
  });
});
