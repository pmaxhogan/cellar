import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { effectScope } from "vue";
import {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  backoffDelay,
  createEventStream,
  type EventSourceCtor,
  type StreamState,
} from "../src/api/events.ts";
import type { CellarEvent } from "../src/api/types.ts";
import { useEventsStore } from "../src/stores/events.ts";
import { FakeEventSource } from "./helpers/eventSource.ts";

const ctor = FakeEventSource as unknown as EventSourceCtor;
const frame = (type: string): string => JSON.stringify({ type, at: 1, payload: { ok: true } });

function manualScheduler() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    pending,
    setTimeout: (fn: () => void, ms: number) => {
      const handle = next++;
      pending.set(handle, { fn, ms });
      return handle;
    },
    clearTimeout: (handle: number) => {
      pending.delete(handle);
    },
    runAll(): void {
      const jobs = [...pending.entries()];
      pending.clear();
      for (const [, job] of jobs) job.fn();
    },
  };
}

beforeEach(() => {
  FakeEventSource.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("backoffDelay", () => {
  it("doubles the ceiling per attempt and clamps it", () => {
    const top = () => 1;
    expect(backoffDelay(1, 1000, 30_000, top)).toBe(1000);
    expect(backoffDelay(2, 1000, 30_000, top)).toBe(2000);
    expect(backoffDelay(4, 1000, 30_000, top)).toBe(8000);
    expect(backoffDelay(20, 1000, 30_000, top)).toBe(30_000);
  });

  it("never schedules below the base delay", () => {
    expect(backoffDelay(5, 1000, 30_000, () => 0)).toBe(1000);
    expect(backoffDelay(0, 1000, 30_000, () => 0)).toBe(1000);
  });

  it("has sane defaults", () => {
    expect(DEFAULT_BASE_DELAY_MS).toBe(1000);
    expect(DEFAULT_MAX_DELAY_MS).toBe(30_000);
    const delay = backoffDelay(3);
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(4000);
  });
});

describe("createEventStream", () => {
  it("connects, opens, and delivers unnamed and named frames", () => {
    const events: CellarEvent[] = [];
    const states: StreamState[] = [];
    const stream = createEventStream({
      url: "/api/events",
      eventSourceCtor: ctor,
      eventTypes: ["job.done"],
      onEvent: (event) => events.push(event),
      onStateChange: (state) => states.push(state),
    });
    expect(stream.state).toBe("idle");
    stream.start();
    stream.start(); // idempotent
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.latest();
    source.open();
    source.message(frame("job.started"));
    source.named("job.done", frame("job.done"));
    source.message("garbage");
    source.message(42);
    expect(events.map((event) => event.type)).toEqual(["job.started", "job.done"]);
    expect(states).toEqual(["connecting", "open"]);
    expect(stream.state).toBe("open");
  });

  it("reconnects with backoff after an error, and resets attempts on open", () => {
    const scheduler = manualScheduler();
    const stream = createEventStream({
      eventSourceCtor: ctor,
      scheduler,
      random: () => 1,
      baseDelayMs: 100,
      maxDelayMs: 1000,
    });
    stream.start();
    FakeEventSource.latest().fail();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(stream.state).toBe("reconnecting");
    expect(stream.attempts).toBe(1);
    expect([...scheduler.pending.values()][0]!.ms).toBe(100);

    scheduler.runAll();
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.latest().fail();
    expect([...scheduler.pending.values()][0]!.ms).toBe(200);

    scheduler.runAll();
    FakeEventSource.latest().open();
    expect(stream.attempts).toBe(0);
    expect(stream.state).toBe("open");
  });

  it("stops cleanly: closes the socket, cancels the retry, ignores late errors", () => {
    const scheduler = manualScheduler();
    const stream = createEventStream({ eventSourceCtor: ctor, scheduler });
    stream.start();
    const first = FakeEventSource.latest();
    first.fail();
    expect(scheduler.pending.size).toBe(1);
    stream.stop();
    expect(scheduler.pending.size).toBe(0);
    expect(stream.state).toBe("closed");

    stream.start();
    const second = FakeEventSource.latest();
    stream.stop();
    expect(second.closed).toBe(true);
    second.fail();
    expect(scheduler.pending.size).toBe(0);
  });

  it("does not reconnect when stopped while a retry was already firing", () => {
    const scheduler = manualScheduler();
    const stream = createEventStream({ eventSourceCtor: ctor, scheduler });
    stream.start();
    FakeEventSource.latest().fail();
    const [job] = [...scheduler.pending.values()];
    stream.stop();
    job!.fn();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("closes immediately when there is no EventSource at all", () => {
    vi.stubGlobal("EventSource", undefined);
    const stream = createEventStream();
    stream.start();
    expect(stream.state).toBe("closed");
  });

  it("uses the global EventSource and default timers when none are injected", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const stream = createEventStream();
    stream.start();
    expect(FakeEventSource.latest().url).toBe("/api/events");
    stream.stop();
  });
});

describe("events store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  it("opens one stream, fans events out, and tracks state", () => {
    const store = useEventsStore();
    const seen: string[] = [];
    store.on((event) => seen.push(`a:${event.type}`));
    store.on((event) => seen.push(`b:${event.type}`));
    store.connect("/api/events");
    store.connect("/api/events");
    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.latest().open();
    expect(store.state).toBe("open");
    FakeEventSource.latest().message(frame("video.added"));
    expect(seen).toEqual(["a:video.added", "b:video.added"]);
    expect(store.lastEvent?.type).toBe("video.added");
    store.disconnect();
    expect(store.state).toBe("closed");
  });

  it("unsubscribes explicitly and when the owning scope is disposed", () => {
    const store = useEventsStore();
    const seen: string[] = [];
    const off = store.on(() => seen.push("explicit"));
    const scope = effectScope();
    scope.run(() => store.on(() => seen.push("scoped")));
    store.dispatch({ type: "x", at: 1, payload: null });
    off();
    scope.stop();
    store.dispatch({ type: "y", at: 2, payload: null });
    expect(seen).toEqual(["explicit", "scoped"]);
  });
});
