import {
  FIELD_CATALOG,
  type AstError,
  type ConditionNode,
  type Field,
  type FieldInfo,
  type OperatorInfo,
  type ValueKind,
} from "@cellar/shared";

/**
 * Editable model of a condition tree for the rule builder.
 *
 * The builder edits nodes in place, so every node carries a stable `_key` the
 * components use for `v-for` keys and drag-and-drop identity; typing into a
 * value never remounts its input. `toAst` strips the keys back off for the
 * wire. Leaves are kept loose (`value: unknown`) because a leaf under edit is
 * routinely invalid; `validateAst` on the stripped tree is the judge.
 */

export interface UiLeaf {
  _key: number;
  type: "cond";
  field: Field;
  op: string;
  value: unknown;
  ci?: boolean;
  source?: string;
}

export interface UiGroup {
  _key: number;
  type: "group";
  op: "and" | "or";
  not?: boolean;
  children: UiNode[];
}

export type UiNode = UiGroup | UiLeaf;

let nextKey = 1;

function newKey(): number {
  nextKey += 1;
  return nextKey;
}

/** Converts a stored AST into the editable model. A lone leaf root is wrapped in an AND group. */
export function toUi(node: unknown): UiGroup {
  const ui = toUiNode(node);
  if (ui.type === "group") return ui;
  return { _key: newKey(), type: "group", op: "and", children: [ui] };
}

function toUiNode(node: unknown): UiNode {
  if (node === null || typeof node !== "object") {
    return { _key: newKey(), type: "group", op: "and", children: [] };
  }
  const n = node as Record<string, unknown>;
  if (n["type"] === "group") {
    const group: UiGroup = {
      _key: newKey(),
      type: "group",
      op: n["op"] === "or" ? "or" : "and",
      children: Array.isArray(n["children"]) ? n["children"].map(toUiNode) : [],
    };
    if (n["not"] === true) group.not = true;
    return group;
  }
  const leaf: UiLeaf = {
    _key: newKey(),
    type: "cond",
    field: n["field"] as Field,
    op: String(n["op"]),
    value: cloneValue(n["value"]),
  };
  if (typeof n["ci"] === "boolean") leaf.ci = n["ci"];
  if (typeof n["source"] === "string") leaf.source = n["source"];
  return leaf;
}

function cloneValue(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

/** Strips the editor keys. The result is what `validateAst` and the API see. */
export function toAst(node: UiNode): ConditionNode {
  if (node.type === "group") {
    const out: Record<string, unknown> = {
      type: "group",
      op: node.op,
      children: node.children.map(toAst),
    };
    if (node.not === true) out["not"] = true;
    return out as unknown as ConditionNode;
  }
  const out: Record<string, unknown> = { type: "cond", field: node.field };
  if (node.source !== undefined) out["source"] = node.source;
  out["op"] = node.op;
  out["value"] = cloneValue(node.value);
  if (node.ci !== undefined) out["ci"] = node.ci;
  return out as unknown as ConditionNode;
}

export function fieldInfo(field: Field): FieldInfo {
  return FIELD_CATALOG[field];
}

export function operatorInfo(field: Field, op: string): OperatorInfo | undefined {
  return FIELD_CATALOG[field]?.operators.find((candidate) => candidate.op === op);
}

/** Midnight UTC today, as an ISO datetime: the starting value of a fresh date input. */
export function todayIso(now = Date.now()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/**
 * The starting value for an operand of `kind`. Lists start empty and ids
 * start unset, so a fresh leaf asks for a choice (validation flags it) rather
 * than silently matching on a guess.
 */
export function defaultValue(kind: ValueKind, info: FieldInfo): unknown {
  switch (kind) {
    case "number":
      return 0;
    case "number_range":
      return [0, info.field === "duration_s" ? 600 : 100];
    case "bool":
    case "null_flag":
      return true;
    case "text":
    case "regex":
      return "";
    case "duration":
      return { days: 14 };
    case "instant":
      return todayIso();
    case "enum":
      return info.options?.[0] ?? "";
    case "enum_list":
    case "source_list":
    case "account_ids":
    case "channel_ids":
      return [];
    case "account_id":
    case "location_id":
    case "channel_id":
      return null;
  }
}

/** A fresh leaf for `field`, on its first operator. */
export function newLeaf(field: Field = "title"): UiLeaf {
  const info = fieldInfo(field);
  const op = info.operators[0]!;
  const leaf: UiLeaf = {
    _key: newKey(),
    type: "cond",
    field,
    op: op.op,
    value: defaultValue(op.value, info),
  };
  if (info.caseFlag === true) leaf.ci = true;
  return leaf;
}

export function newGroup(op: "and" | "or" = "and"): UiGroup {
  return { _key: newKey(), type: "group", op, children: [newLeaf()] };
}

/** Switches a leaf to another field: first operator, fresh value, field-specific flags reset. */
export function changeField(leaf: UiLeaf, field: Field): void {
  const fresh = newLeaf(field);
  leaf.field = fresh.field;
  leaf.op = fresh.op;
  leaf.value = fresh.value;
  if (fresh.ci === undefined) delete leaf.ci;
  else leaf.ci = fresh.ci;
  delete leaf.source;
}

/**
 * Switches a leaf's operator. The value is kept when the new operator takes
 * the same kind of operand (`lt` -> `gte`); a single value and a list convert
 * into each other; anything else starts fresh.
 */
export function changeOp(leaf: UiLeaf, op: string): void {
  const info = fieldInfo(leaf.field);
  const before = operatorInfo(leaf.field, leaf.op)?.value;
  const after = operatorInfo(leaf.field, op)?.value;
  leaf.op = op;
  if (after === undefined || before === after) return;
  const single = new Set<ValueKind>(["enum", "account_id", "channel_id"]);
  const multi = new Set<ValueKind>(["enum_list", "account_ids", "channel_ids"]);
  if (before !== undefined && single.has(before) && multi.has(after)) {
    leaf.value = leaf.value === null || leaf.value === "" ? [] : [leaf.value];
    return;
  }
  if (before !== undefined && multi.has(before) && single.has(after)) {
    const first: unknown = Array.isArray(leaf.value) ? leaf.value[0] : undefined;
    leaf.value = first ?? defaultValue(after, info);
    return;
  }
  if (before === "number" && after === "number_range" && typeof leaf.value === "number") {
    leaf.value = [leaf.value, leaf.value];
    return;
  }
  if (before === "number_range" && after === "number" && Array.isArray(leaf.value)) {
    leaf.value = (leaf.value[0] as unknown) ?? 0;
    return;
  }
  if ((before === "text" && after === "regex") || (before === "regex" && after === "text")) {
    return;
  }
  leaf.value = defaultValue(after, info);
}

/** The group directly containing `target`, and its index there; null for the root or a stranger. */
export function findParent(
  root: UiGroup,
  target: UiNode,
): { parent: UiGroup; index: number } | null {
  const stack: UiGroup[] = [root];
  while (stack.length > 0) {
    const group = stack.pop()!;
    const index = group.children.indexOf(target);
    if (index >= 0) return { parent: group, index };
    for (const child of group.children) if (child.type === "group") stack.push(child);
  }
  return null;
}

/** True when `node` is `ancestor` or inside it. */
export function contains(ancestor: UiNode, node: UiNode): boolean {
  if (ancestor === node) return true;
  if (ancestor.type !== "group") return false;
  return ancestor.children.some((child) => contains(child, node));
}

export function removeNode(root: UiGroup, target: UiNode): boolean {
  const found = findParent(root, target);
  if (found === null) return false;
  found.parent.children.splice(found.index, 1);
  return true;
}

/**
 * Moves `node` into `group`, before `before` (or to the end when `before` is
 * null). Refuses to move a group into itself or its own descendants, or to
 * move the root. Returns whether anything moved.
 */
export function moveNode(
  root: UiGroup,
  node: UiNode,
  group: UiGroup,
  before: UiNode | null,
): boolean {
  if (node === before) return false;
  if (contains(node, group)) return false;
  const from = findParent(root, node);
  if (from === null) return false;
  if (group !== root && findParent(root, group) === null) return false;
  if (before !== null && !group.children.includes(before)) return false;
  from.parent.children.splice(from.index, 1);
  const at = before === null ? group.children.length : group.children.indexOf(before);
  group.children.splice(at, 0, node);
  return true;
}

/** Moves a node one place up or down within its group. */
export function shiftNode(root: UiGroup, node: UiNode, delta: -1 | 1): boolean {
  const found = findParent(root, node);
  if (found === null) return false;
  const to = found.index + delta;
  if (to < 0 || to >= found.parent.children.length) return false;
  const list = found.parent.children;
  [list[found.index], list[to]] = [list[to]!, list[found.index]!];
  return true;
}

/** Validation errors grouped by the `_key` of the node they belong to (the deepest node on the path). */
export function errorsByKey(root: UiGroup, errors: readonly AstError[]): Map<number, AstError[]> {
  const out = new Map<number, AstError[]>();
  for (const error of errors) {
    let node: UiNode = root;
    const path = error.path;
    for (let i = 0; i + 1 < path.length; i += 2) {
      if (node.type !== "group" || path[i] !== "children") break;
      const child: UiNode | undefined = node.children[Number(path[i + 1])];
      if (child === undefined) break;
      node = child;
    }
    const list = out.get(node._key) ?? [];
    list.push(error);
    out.set(node._key, list);
  }
  return out;
}

/** Splits seconds into h/m/s for the duration picker. */
export function splitSeconds(total: number): { h: number; m: number; s: number } {
  const t = Math.max(0, Math.round(total));
  return { h: Math.floor(t / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
}

export function joinSeconds(parts: { h: number; m: number; s: number }): number {
  return parts.h * 3600 + parts.m * 60 + parts.s;
}

export type DurationObjectValue = {
  years?: number;
  months?: number;
  days?: number;
  hours?: number;
};

const ISO_RE =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * A rule duration as the `{ years, months, days, hours }` object the age
 * editor edits. ISO strings convert when they only use those units (weeks
 * become days); anything with minutes or seconds returns null and the editor
 * falls back to the raw ISO text.
 */
export function toDurationObject(value: unknown): DurationObjectValue | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    const out: DurationObjectValue = {};
    for (const unit of ["years", "months", "days", "hours"] as const) {
      if (typeof v[unit] === "number") out[unit] = v[unit];
    }
    return out;
  }
  if (typeof value !== "string") return null;
  const m = ISO_RE.exec(value);
  if (m === null) return null;
  const [, y, mo, w, d, h, mi, s] = m;
  if (mi !== undefined || s !== undefined) return null;
  const out: DurationObjectValue = {};
  if (y !== undefined) out.years = Number(y);
  if (mo !== undefined) out.months = Number(mo);
  if (w !== undefined || d !== undefined) out.days = Number(w ?? 0) * 7 + Number(d ?? 0);
  if (h !== undefined) out.hours = Number(h);
  return out;
}
