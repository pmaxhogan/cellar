import { z } from "zod";
import { RowIdSchema } from "./effects.ts";
import { checkRegexSafety } from "./safeRegex.ts";
import { RuleDurationSchema, RuleInstantSchema } from "./time.ts";

/**
 * Condition AST for custom rules (spec 4.4):
 *
 *   Group = { type: "group", op: "and" | "or", not?: boolean, children: Node[] }
 *   Leaf  = { type: "cond", field, op, value, ci?, source? }
 *
 * Leaves are a discriminated union on `field`, each field a discriminated
 * union on `op`, so every (field, op) pair has its own value schema. Text
 * leaves take an optional `ci` (case-insensitive) flag; `first_seen` leaves
 * take an optional `source` parameter. An empty `and` group matches every
 * video, an empty `or` group matches none.
 */

export const SOURCE_KINDS = ["history", "watch_later", "liked", "subscription", "channel"] as const;
export const SourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const VIDEO_TYPES = ["video", "short", "livestream", "premiere"] as const;
export const VideoTypeSchema = z.enum(VIDEO_TYPES);
export type VideoType = z.infer<typeof VideoTypeSchema>;

/** Values of the derived `status` field. `gone` overlaps `private` and `removed`. */
export const STATUS_VALUES = ["public", "unlisted", "gone", "private", "removed"] as const;
export type VideoStatus = (typeof STATUS_VALUES)[number];

export const CODECS = ["av1", "vp9", "h264"] as const;
export type Codec = (typeof CODECS)[number];

export const SET_OPS = ["has_any", "has_all", "has_only", "has_none"] as const;
export const NUMBER_OPS = ["lt", "lte", "gt", "gte", "between"] as const;
export const TEXT_OPS = [
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "eq",
  "regex",
  "not_regex",
] as const;
export const TIME_OPS = ["age_gt", "age_lt", "before", "after", "is_null"] as const;

/** Longest literal accepted by the text operators. */
export const MAX_TEXT_VALUE = 1000;
/** Longest list accepted by `in` and the source set operators. */
export const MAX_LIST_VALUE = 500;
/** Deepest group nesting `validateAst` accepts (a lone root node is depth 1). */
export const MAX_AST_DEPTH = 16;
/** Most nodes (groups plus leaves) `validateAst` accepts. */
export const MAX_AST_NODES = 500;

const COND = z.literal("cond");

function leaf<F extends string, O extends string, V extends z.ZodType>(field: F, op: O, value: V) {
  return z.strictObject({ type: COND, field: z.literal(field), op: z.literal(op), value });
}

function list<T extends z.ZodType>(item: T) {
  return z.array(item).min(1).max(MAX_LIST_VALUE);
}

const ChannelIdValue = z.string().min(1).max(64);
const NumberValue = z.number();
const NumberRangeValue = z
  .tuple([z.number(), z.number()])
  .refine(([lo, hi]) => lo <= hi, { message: "between needs [min, max] with min <= max" });
const TextValue = z.string().max(MAX_TEXT_VALUE);

/** A regex operand: compiles, is short enough, and passes the static safety check. */
export const RegexValueSchema = z.string().superRefine((pattern, ctx) => {
  const issue = checkRegexSafety(pattern);
  if (issue) {
    ctx.addIssue({ code: "custom", message: issue.message, params: { regex: issue.code } });
  }
});

function idLeaf<F extends string, V extends z.ZodType>(field: F, id: V) {
  return z.discriminatedUnion("op", [leaf(field, "eq", id), leaf(field, "in", list(id))]);
}

function enumLeaf<F extends string, const E extends readonly [string, ...string[]]>(
  field: F,
  values: E,
) {
  const item = z.enum(values);
  return z.discriminatedUnion("op", [leaf(field, "eq", item), leaf(field, "in", list(item))]);
}

function numberLeaf<F extends string>(field: F) {
  return z.discriminatedUnion("op", [
    leaf(field, "lt", NumberValue),
    leaf(field, "lte", NumberValue),
    leaf(field, "gt", NumberValue),
    leaf(field, "gte", NumberValue),
    leaf(field, "between", NumberRangeValue),
  ]);
}

function boolLeaf<F extends string>(field: F) {
  return leaf(field, "eq", z.boolean());
}

function textOp<F extends string, O extends string, V extends z.ZodType>(
  field: F,
  op: O,
  value: V,
) {
  return z.strictObject({
    type: COND,
    field: z.literal(field),
    op: z.literal(op),
    value,
    ci: z.boolean().optional(),
  });
}

function textLeaf<F extends string>(field: F) {
  return z.discriminatedUnion("op", [
    textOp(field, "contains", TextValue),
    textOp(field, "not_contains", TextValue),
    textOp(field, "starts_with", TextValue),
    textOp(field, "ends_with", TextValue),
    textOp(field, "eq", TextValue),
    textOp(field, "regex", RegexValueSchema),
    textOp(field, "not_regex", RegexValueSchema),
  ]);
}

function timeLeaf<F extends string>(field: F) {
  return z.discriminatedUnion("op", [
    leaf(field, "age_gt", RuleDurationSchema),
    leaf(field, "age_lt", RuleDurationSchema),
    leaf(field, "before", RuleInstantSchema),
    leaf(field, "after", RuleInstantSchema),
    leaf(field, "is_null", z.boolean()),
  ]);
}

function firstSeenOp<O extends string, V extends z.ZodType>(op: O, value: V) {
  return z.strictObject({
    type: COND,
    field: z.literal("first_seen"),
    source: SourceKindSchema.optional(),
    op: z.literal(op),
    value,
  });
}

const UploadDateLeaf = z.discriminatedUnion("op", [
  leaf("upload_date", "age_gt", RuleDurationSchema),
  leaf("upload_date", "age_lt", RuleDurationSchema),
  leaf("upload_date", "before", RuleInstantSchema),
  leaf("upload_date", "after", RuleInstantSchema),
  leaf("upload_date", "is_null", z.boolean()),
  leaf("upload_date", "before_install_minus", RuleDurationSchema),
]);

const FirstSeenLeaf = z.discriminatedUnion("op", [
  firstSeenOp("age_gt", RuleDurationSchema),
  firstSeenOp("age_lt", RuleDurationSchema),
  firstSeenOp("before", RuleInstantSchema),
  firstSeenOp("after", RuleInstantSchema),
  firstSeenOp("is_null", z.boolean()),
]);

const SourceLeaf = z.discriminatedUnion("op", [
  leaf("source", "has_any", list(SourceKindSchema)),
  leaf("source", "has_all", list(SourceKindSchema)),
  leaf("source", "has_only", list(SourceKindSchema)),
  leaf("source", "has_none", list(SourceKindSchema)),
]);

export const LeafSchema = z.discriminatedUnion("field", [
  idLeaf("account", RowIdSchema),
  SourceLeaf,
  enumLeaf("type", VIDEO_TYPES),
  idLeaf("channel", ChannelIdValue),
  enumLeaf("status", STATUS_VALUES),
  numberLeaf("duration_s"),
  numberLeaf("views"),
  numberLeaf("likes"),
  numberLeaf("comments"),
  numberLeaf("ryd_ratio"),
  numberLeaf("max_height"),
  numberLeaf("max_fps"),
  enumLeaf("has_codec", CODECS),
  boolLeaf("is_hdr"),
  boolLeaf("caption_available"),
  boolLeaf("has_share_link"),
  boolLeaf("downloaded"),
  leaf("current_location", "eq", RowIdSchema),
  textLeaf("title"),
  textLeaf("description"),
  textLeaf("tags"),
  textLeaf("channel_title"),
  UploadDateLeaf,
  FirstSeenLeaf,
  timeLeaf("downloaded_at"),
  timeLeaf("last_seen"),
  timeLeaf("now"),
]);
export type LeafNode = z.infer<typeof LeafSchema>;
export type Field = LeafNode["field"];
export type LeafOf<F extends Field> = Extract<LeafNode, { field: F }>;

export const GROUP_OPS = ["and", "or"] as const;
export type GroupOp = (typeof GROUP_OPS)[number];

export interface GroupNode {
  type: "group";
  op: GroupOp;
  not?: boolean | undefined;
  children: ConditionNode[];
}
export type ConditionNode = GroupNode | LeafNode;

export const GroupSchema = z.strictObject({
  type: z.literal("group"),
  op: z.enum(GROUP_OPS),
  not: z.boolean().optional(),
  get children(): z.ZodArray<z.ZodType<ConditionNode>> {
    return z.array(ConditionSchema);
  },
});

/**
 * Zod schema for a whole condition tree. It does not bound depth; parse
 * untrusted input with `validateAst`, which does.
 */
export const ConditionSchema: z.ZodType<ConditionNode> = z.discriminatedUnion("type", [
  GroupSchema,
  LeafSchema,
]);

/** The empty `and` group: matches every video. */
export function matchAll(): GroupNode {
  return { type: "group", op: "and", children: [] };
}

// ---------------------------------------------------------------------------
// Validation with JSON paths
// ---------------------------------------------------------------------------

export type AstErrorCode =
  | "too_deep"
  | "too_many_nodes"
  | "unknown_type"
  | "unknown_field"
  | "unknown_op"
  | "unsafe_regex"
  | "invalid_value"
  | "invalid";

export interface AstError {
  /** Path from the root, e.g. ["children", 0, "value"]. */
  path: (string | number)[];
  /** The same path as a JSON pointer, e.g. "/children/0/value" ("" = the root). */
  pointer: string;
  code: AstErrorCode;
  message: string;
}

export type ValidateAstResult =
  { ok: true; node: ConditionNode; errors: [] } | { ok: false; node: null; errors: AstError[] };

function toPointer(path: (string | number)[]): string {
  return path.map((p) => `/${String(p).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

function astError(path: (string | number)[], code: AstErrorCode, message: string): AstError {
  return { path, pointer: toPointer(path), code, message };
}

/** Iterative walk that bounds depth and size before zod recurses into the tree. */
function checkShape(node: unknown): AstError | null {
  const stack: { node: unknown; depth: number; path: (string | number)[] }[] = [
    { node, depth: 1, path: [] },
  ];
  let count = 0;
  while (stack.length > 0) {
    const item = stack.pop()!;
    count += 1;
    if (count > MAX_AST_NODES) {
      return astError([], "too_many_nodes", `a condition may have at most ${MAX_AST_NODES} nodes`);
    }
    if (item.depth > MAX_AST_DEPTH) {
      return astError(item.path, "too_deep", `conditions may nest at most ${MAX_AST_DEPTH} deep`);
    }
    const n = item.node;
    if (n !== null && typeof n === "object" && (n as { type?: unknown }).type === "group") {
      const children = (n as { children?: unknown }).children;
      if (Array.isArray(children)) {
        children.forEach((child, i) => {
          stack.push({ node: child, depth: item.depth + 1, path: [...item.path, "children", i] });
        });
      }
    }
  }
  return null;
}

function issueCode(issue: z.core.$ZodIssue): AstErrorCode {
  if (issue.code === "invalid_union" && "discriminator" in issue) {
    if (issue.discriminator === "type") return "unknown_type";
    if (issue.discriminator === "field") return "unknown_field";
    if (issue.discriminator === "op") return "unknown_op";
  }
  if (issue.code === "custom" && issue.params?.["regex"] !== undefined) return "unsafe_regex";
  // Single-operator fields (booleans, current_location) fail on the `op` literal itself.
  if (issue.path[issue.path.length - 1] === "op") return "unknown_op";
  if (issue.path.includes("value")) return "invalid_value";
  return "invalid";
}

/**
 * Validates an untrusted condition tree. Returns the parsed node, or every
 * problem found with its JSON path. Depth and node count are bounded first so
 * a hostile tree cannot exhaust the stack.
 */
export function validateAst(node: unknown): ValidateAstResult {
  const shape = checkShape(node);
  if (shape) return { ok: false, node: null, errors: [shape] };
  const parsed = ConditionSchema.safeParse(node);
  if (parsed.success) return { ok: true, node: parsed.data, errors: [] };
  const errors = parsed.error.issues.map((issue) => {
    const path = issue.path.filter((p): p is string | number => typeof p !== "symbol");
    return astError(path, issueCode(issue), issue.message);
  });
  return { ok: false, node: null, errors };
}

// ---------------------------------------------------------------------------
// Field catalog for the rule builder UI
// ---------------------------------------------------------------------------

export type FieldKind = "id" | "set" | "enum" | "number" | "bool" | "text" | "time";

/** Which input the UI renders for an operator's value. */
export type ValueKind =
  | "account_id"
  | "account_ids"
  | "channel_id"
  | "channel_ids"
  | "location_id"
  | "enum"
  | "enum_list"
  | "source_list"
  | "number"
  | "number_range"
  | "bool"
  | "text"
  | "regex"
  | "duration"
  | "instant"
  | "null_flag";

export interface OperatorInfo {
  op: string;
  label: string;
  value: ValueKind;
}

export interface FieldInfo {
  field: Field;
  label: string;
  kind: FieldKind;
  operators: readonly OperatorInfo[];
  /** Allowed values for `enum` / `enum_list` / `source_list` operands and the `source` param. */
  options?: readonly string[];
  /** Text fields: the leaf accepts a `ci` (case-insensitive) flag. */
  caseFlag?: boolean;
  /** `first_seen`: the leaf accepts an optional `source` parameter. */
  sourceParam?: boolean;
  description?: string;
}

const OP_LABELS: Record<string, string> = {
  eq: "is",
  in: "is any of",
  has_any: "has any of",
  has_all: "has all of",
  has_only: "has only",
  has_none: "has none of",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  between: "between",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  regex: "matches regex",
  not_regex: "does not match regex",
  age_gt: "older than",
  age_lt: "newer than",
  before: "before",
  after: "after",
  is_null: "is empty",
  before_install_minus: "before install minus",
};

function ops(entries: readonly (readonly [string, ValueKind])[]): OperatorInfo[] {
  return entries.map(([op, value]) => ({ op, label: OP_LABELS[op] ?? op, value }));
}

const NUMBER_OPERATORS = ops([
  ["lt", "number"],
  ["lte", "number"],
  ["gt", "number"],
  ["gte", "number"],
  ["between", "number_range"],
]);
const ENUM_OPERATORS = ops([
  ["eq", "enum"],
  ["in", "enum_list"],
]);
const BOOL_OPERATORS = ops([["eq", "bool"]]);
const TEXT_OPERATORS = ops([
  ["contains", "text"],
  ["not_contains", "text"],
  ["starts_with", "text"],
  ["ends_with", "text"],
  ["eq", "text"],
  ["regex", "regex"],
  ["not_regex", "regex"],
]);
const TIME_OPERATORS = ops([
  ["age_gt", "duration"],
  ["age_lt", "duration"],
  ["before", "instant"],
  ["after", "instant"],
  ["is_null", "null_flag"],
]);
const SOURCE_OPERATORS = ops(SET_OPS.map((op) => [op, "source_list"] as const));

function numberField(field: Field, label: string, description?: string): FieldInfo {
  return { field, label, kind: "number", operators: NUMBER_OPERATORS, description };
}
function boolField(field: Field, label: string): FieldInfo {
  return { field, label, kind: "bool", operators: BOOL_OPERATORS };
}
function textField(field: Field, label: string, description?: string): FieldInfo {
  return { field, label, kind: "text", operators: TEXT_OPERATORS, caseFlag: true, description };
}
function timeField(field: Field, label: string, description: string): FieldInfo {
  return { field, label, kind: "time", operators: TIME_OPERATORS, description };
}

/** Every condition field with its operators and value kinds, in builder display order. */
export const FIELD_CATALOG: Readonly<Record<Field, FieldInfo>> = {
  account: {
    field: "account",
    label: "Account",
    kind: "id",
    operators: ops([
      ["eq", "account_id"],
      ["in", "account_ids"],
    ]),
    description: "Any of the video's sources came from this account.",
  },
  source: {
    field: "source",
    label: "Source",
    kind: "set",
    operators: SOURCE_OPERATORS,
    options: SOURCE_KINDS,
    description: "The set of sources the video currently has, across all accounts.",
  },
  type: {
    field: "type",
    label: "Type",
    kind: "enum",
    operators: ENUM_OPERATORS,
    options: VIDEO_TYPES,
  },
  channel: {
    field: "channel",
    label: "Channel",
    kind: "id",
    operators: ops([
      ["eq", "channel_id"],
      ["in", "channel_ids"],
    ]),
  },
  status: {
    field: "status",
    label: "Status",
    kind: "enum",
    operators: ENUM_OPERATORS,
    options: STATUS_VALUES,
    description: "Gone = private, removed or unavailable, or marked gone by rechecks.",
  },
  duration_s: numberField("duration_s", "Duration (seconds)"),
  views: numberField("views", "Views"),
  likes: numberField("likes", "Likes"),
  comments: numberField("comments", "Comments"),
  ryd_ratio: numberField("ryd_ratio", "Like ratio (estimated)", "Return YouTube Dislike estimate."),
  max_height: numberField("max_height", "Max available height"),
  max_fps: numberField("max_fps", "Max available frame rate"),
  has_codec: {
    field: "has_codec",
    label: "Available codec",
    kind: "enum",
    operators: ENUM_OPERATORS,
    options: CODECS,
    description: "YouTube offers a format in this codec.",
  },
  is_hdr: boolField("is_hdr", "HDR"),
  caption_available: boolField("caption_available", "Captions available"),
  has_share_link: boolField("has_share_link", "Has a share link"),
  downloaded: boolField("downloaded", "Downloaded"),
  current_location: {
    field: "current_location",
    label: "Current location",
    kind: "id",
    operators: ops([["eq", "location_id"]]),
  },
  title: textField("title", "Title"),
  description: textField("description", "Description"),
  tags: textField("tags", "Tags", "Matches when any tag matches; negated operators need no tag."),
  channel_title: textField("channel_title", "Channel name"),
  upload_date: {
    field: "upload_date",
    label: "Upload date",
    kind: "time",
    operators: [...TIME_OPERATORS, ...ops([["before_install_minus", "duration"]])],
    description: "Upload date (the publish date when the upload date is unknown).",
  },
  first_seen: {
    ...timeField(
      "first_seen",
      "First seen",
      "Earliest time the video was seen in the chosen source, or in any source.",
    ),
    sourceParam: true,
    options: SOURCE_KINDS,
  },
  downloaded_at: timeField("downloaded_at", "Downloaded at", "When the current media finished."),
  last_seen: timeField("last_seen", "Last seen", "Latest time the video was seen in any source."),
  now: timeField("now", "Now", "The evaluation clock, for date-window rules."),
};

/** The fields in display order. */
export const FIELDS = Object.keys(FIELD_CATALOG) as Field[];
