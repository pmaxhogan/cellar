/**
 * One frame on the /api/events stream. `type` names what changed (for example
 * "job.updated"); `at` is epoch ms; `payload` carries ids, never credentials.
 */
export interface CellarEvent {
  type: string;
  at: number;
  payload: Record<string, unknown>;
}

export type EventListener = (event: CellarEvent) => void;

/**
 * In-process fan-out for live UI updates. routes/events.ts subscribes one
 * listener per open SSE connection; jobs and domain code publish.
 */
export class EventBus {
  readonly #listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  publish(type: string, payload: Record<string, unknown> = {}): void {
    const event: CellarEvent = { type, at: Date.now(), payload };
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  get subscriberCount(): number {
    return this.#listeners.size;
  }

  clear(): void {
    this.#listeners.clear();
  }
}
