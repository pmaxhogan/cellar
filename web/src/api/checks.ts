import { z } from "zod";
import { buildQuery, type ApiClient } from "./client.ts";

/**
 * Self-check API (/api/checks). Local schemas until the wave1C block of
 * shared/src/apiTypes.ts lands with the same shape.
 *
 *   GET  /api/checks?limit   -> { rows: CheckRow[] }
 *   GET  /api/checks/latest  -> CheckRow
 *   POST /api/checks/run     -> CheckRow
 */
export const CHECK_LEVELS = ["ok", "warn", "fail", "skip"] as const;
export type CheckLevel = (typeof CHECK_LEVELS)[number];

export const CheckResultSchema = z.object({
  key: z.string(),
  label: z.string(),
  level: z.enum(CHECK_LEVELS),
  detail: z.string(),
  value: z.unknown().optional(),
  took_ms: z.number(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const CheckRowSchema = z.object({
  id: z.number().int(),
  run_at: z.number(),
  trigger: z.string(),
  ok: z.boolean(),
  results: z.array(CheckResultSchema),
});
export type CheckRow = z.infer<typeof CheckRowSchema>;

export const ChecksListResponseSchema = z.object({ rows: z.array(CheckRowSchema) });

export async function listChecks(api: ApiClient, limit = 30): Promise<CheckRow[]> {
  const result = await api.request(`/api/checks${buildQuery({ limit })}`, {
    schema: ChecksListResponseSchema,
  });
  return result.rows;
}

export function latestCheck(api: ApiClient): Promise<CheckRow> {
  return api.request("/api/checks/latest", { schema: CheckRowSchema });
}

export function runCheck(api: ApiClient): Promise<CheckRow> {
  return api.request("/api/checks/run", { method: "POST", schema: CheckRowSchema });
}

/** Display groups, in grid order. A key's group is its prefix before the first dot. */
export const CHECK_GROUPS: readonly { key: string; label: string }[] = [
  { key: "data", label: "Data and storage" },
  { key: "db", label: "Database" },
  { key: "tools", label: "Tools" },
  { key: "gpu", label: "GPU" },
  { key: "pot", label: "PO-token provider" },
  { key: "youtube", label: "YouTube" },
  { key: "account", label: "Accounts" },
  { key: "push", label: "Push" },
  { key: "clock", label: "Clock" },
  { key: "proxy", label: "Proxies" },
];

export interface CheckGroup {
  key: string;
  label: string;
  results: CheckResult[];
  /** The worst level in the group. */
  level: CheckLevel;
}

const SEVERITY: Record<CheckLevel, number> = { skip: 0, ok: 1, warn: 2, fail: 3 };

export function worstLevel(results: readonly CheckResult[]): CheckLevel {
  let worst: CheckLevel = "skip";
  for (const result of results) {
    if (SEVERITY[result.level] > SEVERITY[worst]) worst = result.level;
  }
  return worst;
}

export function checkPrefix(key: string): string {
  const match = /^[a-z0-9_-]+/i.exec(key);
  return (match?.[0] ?? key).toLowerCase();
}

/**
 * Group results by key prefix (`tools.ytdlp` -> tools). Known groups keep their
 * fixed order; anything else lands in an "Other" group at the end, so a new
 * check on the server still shows up before the UI learns its name.
 */
export function groupResults(results: readonly CheckResult[]): CheckGroup[] {
  const buckets = new Map<string, CheckResult[]>();
  for (const result of results) {
    const prefix = checkPrefix(result.key);
    const known = CHECK_GROUPS.some((group) => group.key === prefix);
    const bucket = known ? prefix : "other";
    const list = buckets.get(bucket) ?? [];
    list.push(result);
    buckets.set(bucket, list);
  }
  const groups: CheckGroup[] = [];
  for (const group of [...CHECK_GROUPS, { key: "other", label: "Other" }]) {
    const list = buckets.get(group.key);
    if (list === undefined) continue;
    groups.push({ key: group.key, label: group.label, results: list, level: worstLevel(list) });
  }
  return groups;
}

export function failingCount(row: Pick<CheckRow, "results">): number {
  return row.results.filter((result) => result.level === "fail").length;
}

export function warningCount(row: Pick<CheckRow, "results">): number {
  return row.results.filter((result) => result.level === "warn").length;
}
