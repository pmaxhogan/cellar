/**
 * YouTube-side edits (docs/ARCHITECTURE.md "Versions"). The recheck engine
 * calls detectEdit with the stored and the freshly fetched metadata; on true
 * it enqueues a `download` job with payload `{ reason: "version" }`, and the
 * download handler keeps the old current media under `versions/v<N>/`.
 */

/** Durations that differ by more than this many seconds mean the video was edited. */
export const EDIT_DURATION_TOLERANCE_S = 2;

export interface EditSnapshot {
  duration_s?: number | null;
  content_signature?: string | null;
}

function known<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * True when `after` describes different content than `before`: the duration
 * moved by more than 2 s, or the API's content signature changed. A value
 * that is unknown on either side never counts as a change.
 */
export function detectEdit(before: EditSnapshot, after: EditSnapshot): boolean {
  if (
    known(before.duration_s) &&
    known(after.duration_s) &&
    Number.isFinite(before.duration_s) &&
    Number.isFinite(after.duration_s) &&
    Math.abs(before.duration_s - after.duration_s) > EDIT_DURATION_TOLERANCE_S
  ) {
    return true;
  }
  return (
    known(before.content_signature) &&
    known(after.content_signature) &&
    before.content_signature !== "" &&
    after.content_signature !== "" &&
    before.content_signature !== after.content_signature
  );
}
