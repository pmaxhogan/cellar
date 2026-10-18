import type { EventSourceLike } from "../../src/api/events.ts";

/**
 * In-memory EventSource. Every instance is recorded so a test can open it,
 * push frames into it, or fail it, and then assert on what the code did.
 */
export class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];

  onopen: ((this: unknown, ev: Event) => unknown) | null = null;
  onerror: ((this: unknown, ev: Event) => unknown) | null = null;
  onmessage: ((this: unknown, ev: MessageEvent) => unknown) | null = null;
  readonly listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }

  /** An unnamed `data:` frame. */
  message(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  /** A frame with an `event:` line. */
  named(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data }));
    }
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }

  static latest(): FakeEventSource {
    const last = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    if (last === undefined) throw new Error("No EventSource was opened");
    return last;
  }
}
