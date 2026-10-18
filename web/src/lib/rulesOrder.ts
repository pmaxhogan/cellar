import type { RuleRow } from "@cellar/shared";

/**
 * Rule list ordering. Custom rules are shown in ascending `position`, which
 * is ascending priority: the last rule in the list wins.
 */

/** Custom rules in priority order (position ascending, then id), global and video rules dropped. */
export function sortedCustom(rows: readonly RuleRow[]): RuleRow[] {
  return rows
    .filter((row) => row.kind === "custom")
    .sort((a, b) => a.position - b.position || a.id - b.id);
}

/** A copy of `list` with the item at `from` moved to index `to` (clamped). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item as T);
  return next;
}

/** The position a new rule should take: after every existing custom rule. */
export function nextPosition(rows: readonly RuleRow[]): number {
  return (
    rows.reduce((max, row) => (row.kind === "custom" ? Math.max(max, row.position) : max), 0) + 1
  );
}
