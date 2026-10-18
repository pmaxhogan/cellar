import { z } from "zod";

/**
 * Web-side schemas for wire shapes that shared/ does not define yet.
 *
 * The SSE frame is `{type, at, payload}` (docs/ARCHITECTURE.md). Event types are
 * open strings here because the server's catalogue lands in wave 1; when
 * shared/ exports a type list and frame schema, this file should re-export
 * them instead and CELLAR_EVENT_TYPES should come from there.
 */
export const cellarEventSchema = z.object({
  type: z.string().min(1),
  at: z.number(),
  payload: z.unknown(),
});
export type CellarEvent = z.infer<typeof cellarEventSchema>;

/**
 * Named SSE event types to subscribe to. EventSource only fires `onmessage` for
 * frames without an `event:` line, so a server that names its frames must have
 * every name listed here (or in shared/) or the UI never sees them.
 */
export const CELLAR_EVENT_TYPES: readonly string[] = [];
