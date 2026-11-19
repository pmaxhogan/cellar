import type { QuickAddResponse } from "@cellar/shared";

/**
 * The Quick add field's paste rules, kept pure so they can be tested without
 * a DOM.
 *
 * A paste is split on whitespace into links. Whatever is already in the field
 * is confirmed first. Then every pasted link but the last is confirmed and the
 * last one is left in the field, waiting for Enter, unless the clipboard ended
 * with a newline: that reads as "Enter was pressed after the last one too", so
 * every link is confirmed and the field ends up empty.
 */
export interface PastePlan {
  /** Inputs to add right away, in order. */
  submit: string[];
  /** What the field holds afterwards. */
  rest: string;
}

export function planPaste(current: string, pasted: string): PastePlan {
  const links = pasted.split(/\s+/).filter((part) => part !== "");
  if (links.length === 0) {
    return { submit: [], rest: current };
  }
  const held = current.trim();
  const submit = held === "" ? [] : [held];
  if (/[\r\n]\s*$/.test(pasted)) {
    return { submit: [...submit, ...links], rest: "" };
  }
  return { submit: [...submit, ...links.slice(0, -1)], rest: links[links.length - 1] as string };
}

/** The confirmation line for a video the server accepted. */
export function quickAddMessage(result: QuickAddResponse): string {
  if (result.downloaded) {
    return "Already downloaded. It is now kept forever.";
  }
  const queued =
    result.job_id === null
      ? "It will be kept forever, but no download could be queued."
      : "Downloading now, and it will be kept forever.";
  return result.created ? `Added. ${queued}` : `Already in the catalog. ${queued}`;
}
