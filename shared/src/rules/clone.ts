/** Deep copy of a JSON-shaped value (plain objects, arrays, primitives). */
export function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v: unknown) => cloneJson(v)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = cloneJson(v);
    return out as T;
  }
  return value;
}
