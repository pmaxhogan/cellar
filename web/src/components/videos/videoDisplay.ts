import type { VideoRow } from "@cellar/shared";

/** Pure display helpers shared by the videos list and the video detail page. */

export type StatusSeverity = "success" | "info" | "warn" | "danger" | "secondary";

export interface StatusBadge {
  label: string;
  severity: StatusSeverity;
}

/**
 * The status a person cares about: public, unlisted, private, or gone (removed
 * or unavailable on YouTube, or flagged gone by a recheck).
 */
export function videoStatus(row: Pick<VideoRow, "privacy" | "gone_since">): StatusBadge {
  const privacy = row.privacy;
  if (row.gone_since !== null || privacy === "removed" || privacy === "unavailable") {
    return { label: "gone", severity: "danger" };
  }
  switch (privacy) {
    case "public":
      return { label: "public", severity: "success" };
    case "unlisted":
      return { label: "unlisted", severity: "info" };
    case "private":
      return { label: "private", severity: "warn" };
    case null:
      return { label: "unknown", severity: "secondary" };
    default:
      return { label: privacy, severity: "secondary" };
  }
}

/** Reclaim priority: -1 keeps forever, 0 is trashed, a positive number is reaped lowest first. */
export function priorityLabel(priority: number | null): string {
  if (priority === null) return "-";
  if (priority < 0) return "keep forever";
  if (priority === 0) return "trashed";
  return String(priority);
}

export const SOURCE_LABELS: Record<string, string> = {
  history: "History",
  watch_later: "Watch later",
  liked: "Liked",
  subscription: "Subscription",
  channel: "Channel",
  manual: "Manual",
  takeout: "Takeout",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export const TYPE_LABELS: Record<string, string> = {
  video: "Video",
  short: "Short",
  livestream: "Livestream",
  premiere: "Premiere",
};

/** "Liked (main)", or just "Liked" when the source has no account. */
export function sourceChip(
  source: { source: string; account_id: number | null },
  accounts: ReadonlyMap<number, string>,
): string {
  const label = sourceLabel(source.source);
  if (source.account_id === null) return label;
  return `${label} (${accounts.get(source.account_id) ?? `account ${source.account_id}`})`;
}

/** A calendar date for an epoch-ms upload date, read in UTC like the server stores it. */
export function formatDay(at: number | null): string {
  if (at === null || !Number.isFinite(at)) return "-";
  return new Date(at).toISOString().slice(0, 10);
}

/** YouTube watch URL for a video id. */
export function watchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
}
