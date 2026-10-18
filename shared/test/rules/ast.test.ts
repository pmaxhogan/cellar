import { describe, expect, it } from "vitest";
import {
  ConditionSchema,
  FIELD_CATALOG,
  FIELDS,
  LeafSchema,
  matchAll,
  MAX_AST_DEPTH,
  MAX_AST_NODES,
  validateAst,
  type ConditionNode,
  type FieldInfo,
  type ValueKind,
} from "../../src/index.ts";

function sample(kind: ValueKind, info: FieldInfo): unknown {
  const first = info.options?.[0];
  switch (kind) {
    case "account_id":
    case "location_id":
      return 3;
    case "account_ids":
      return [1, 2];
    case "channel_id":
      return "UCsynthetic000000000001";
    case "channel_ids":
      return ["UCsynthetic000000000001", "UCsynthetic000000000002"];
    case "enum":
      return first;
    case "enum_list":
    case "source_list":
      return [first];
    case "number":
      return 60;
    case "number_range":
      return [1, 10];
    case "bool":
      return true;
    case "text":
      return "abc";
    case "regex":
      return "^ab+c$";
    case "duration":
      return "P14D";
    case "instant":
      return "2026-01-01T00:00:00Z";
    case "null_flag":
      return true;
  }
}

const ALL_OPS = [
  ...new Set(Object.values(FIELD_CATALOG).flatMap((f) => f.operators.map((o) => o.op))),
];

describe("FIELD_CATALOG", () => {
  it("covers every spec 4.4 field", () => {
    expect([...FIELDS].sort()).toEqual(
      [
        "account",
        "source",
        "type",
        "channel",
        "status",
        "duration_s",
        "views",
        "likes",
        "comments",
        "ryd_ratio",
        "max_height",
        "max_fps",
        "has_codec",
        "is_hdr",
        "caption_available",
        "has_share_link",
        "downloaded",
        "current_location",
        "title",
        "description",
        "tags",
        "channel_title",
        "upload_date",
        "first_seen",
        "downloaded_at",
        "last_seen",
        "now",
      ].sort(),
    );
    for (const field of FIELDS) expect(FIELD_CATALOG[field].field).toBe(field);
  });

  it("lists the spec operators per field", () => {
    const opsOf = (f: keyof typeof FIELD_CATALOG) => FIELD_CATALOG[f].operators.map((o) => o.op);
    expect(opsOf("source")).toEqual(["has_any", "has_all", "has_only", "has_none"]);
    expect(opsOf("views")).toEqual(["lt", "lte", "gt", "gte", "between"]);
    expect(opsOf("title")).toEqual([
      "contains",
      "not_contains",
      "starts_with",
      "ends_with",
      "eq",
      "regex",
      "not_regex",
    ]);
    expect(opsOf("first_seen")).toEqual(["age_gt", "age_lt", "before", "after", "is_null"]);
    expect(opsOf("upload_date")).toContain("before_install_minus");
    expect(opsOf("last_seen")).not.toContain("before_install_minus");
    expect(opsOf("current_location")).toEqual(["eq"]);
    expect(opsOf("is_hdr")).toEqual(["eq"]);
    expect(FIELD_CATALOG.status.options).toEqual([
      "public",
      "unlisted",
      "gone",
      "private",
      "removed",
    ]);
    expect(FIELD_CATALOG.has_codec.options).toEqual(["av1", "vp9", "h264"]);
    expect(FIELD_CATALOG.type.options).toEqual(["video", "short", "livestream", "premiere"]);
    expect(FIELD_CATALOG.first_seen.sourceParam).toBe(true);
    expect(FIELD_CATALOG.tags.caseFlag).toBe(true);
  });

  it("every catalog (field, op) pair parses with a sample value", () => {
    for (const field of FIELDS) {
      const info = FIELD_CATALOG[field];
      for (const { op, value, label } of info.operators) {
        expect(label.length).toBeGreaterThan(0);
        const node = { type: "cond", field, op, value: sample(value, info) };
        const result = validateAst(node);
        expect(result.errors, `${field} ${op}`).toEqual([]);
        expect(result.node).toEqual(node);
      }
    }
  });

  it("every operator not in a field's catalog entry is rejected for that field", () => {
    for (const field of FIELDS) {
      const allowed = FIELD_CATALOG[field].operators.map((o) => o.op);
      for (const op of ALL_OPS.filter((o) => !allowed.includes(o))) {
        const result = validateAst({ type: "cond", field, op, value: 1 });
        expect(result.ok, `${field} ${op}`).toBe(false);
        expect(result.errors[0]).toMatchObject({ path: ["op"], code: "unknown_op" });
      }
    }
  });
});

describe("ConditionSchema", () => {
  const spec11: ConditionNode = {
    type: "group",
    op: "and",
    children: [
      {
        type: "group",
        op: "or",
        children: [
          { type: "cond", field: "channel", op: "eq", value: "UCveritasium00000000000" },
          { type: "cond", field: "channel", op: "eq", value: "UC3blue1brown0000000000" },
        ],
      },
      { type: "cond", field: "duration_s", op: "gt", value: 60 },
      {
        type: "group",
        op: "or",
        children: [
          {
            type: "group",
            op: "and",
            not: true,
            children: [{ type: "cond", field: "type", op: "eq", value: "livestream" }],
          },
          { type: "cond", field: "duration_s", op: "lt", value: 3600 },
        ],
      },
    ],
  };

  it("round-trips a nested tree through JSON", () => {
    const parsed = ConditionSchema.parse(JSON.parse(JSON.stringify(spec11)));
    expect(parsed).toEqual(spec11);
  });

  it("accepts the match-all group", () => {
    expect(ConditionSchema.parse(matchAll())).toEqual({ type: "group", op: "and", children: [] });
    expect(ConditionSchema.parse({ type: "group", op: "or", children: [] })).toBeTruthy();
  });

  it("accepts optional flags where they belong", () => {
    expect(
      LeafSchema.parse({ type: "cond", field: "title", op: "contains", value: "x", ci: true }),
    ).toMatchObject({ ci: true });
    expect(
      LeafSchema.parse({ type: "cond", field: "tags", op: "regex", value: "^a", ci: false }),
    ).toMatchObject({ ci: false });
    expect(
      LeafSchema.parse({
        type: "cond",
        field: "first_seen",
        source: "liked",
        op: "age_gt",
        value: { years: 2 },
      }),
    ).toMatchObject({ source: "liked" });
  });
});

describe("validateAst", () => {
  it("returns the parsed node on success", () => {
    const node = { type: "cond", field: "views", op: "between", value: [1, 2] };
    expect(validateAst(node)).toEqual({ ok: true, node, errors: [] });
  });

  it.each<[string, unknown, (string | number)[], string]>([
    ["unknown type", { type: "nope" }, ["type"], "unknown_type"],
    ["non-object root", 42, [], "invalid"],
    ["null root", null, [], "invalid"],
    [
      "unknown field",
      {
        type: "group",
        op: "and",
        children: [{ type: "cond", field: "colour", op: "eq", value: 1 }],
      },
      ["children", 0, "field"],
      "unknown_field",
    ],
    [
      "unknown op for field",
      {
        type: "group",
        op: "or",
        children: [matchAll(), { type: "cond", field: "views", op: "contains", value: "1" }],
      },
      ["children", 1, "op"],
      "unknown_op",
    ],
    [
      "bad value",
      { type: "cond", field: "views", op: "gt", value: "many" },
      ["value"],
      "invalid_value",
    ],
    [
      "between out of order",
      { type: "cond", field: "duration_s", op: "between", value: [10, 1] },
      ["value"],
      "invalid_value",
    ],
    [
      "between wrong arity",
      { type: "cond", field: "duration_s", op: "between", value: [1, 2, 3] },
      ["value"],
      "invalid_value",
    ],
    [
      "empty in list",
      { type: "cond", field: "type", op: "in", value: [] },
      ["value"],
      "invalid_value",
    ],
    [
      "enum value outside the field's values",
      { type: "cond", field: "status", op: "eq", value: "deleted" },
      ["value"],
      "invalid_value",
    ],
    [
      "bad source in set",
      { type: "cond", field: "source", op: "has_any", value: ["liked", "feed"] },
      ["value", 1],
      "invalid_value",
    ],
    [
      "nested evil regex",
      {
        type: "group",
        op: "and",
        children: [
          {
            type: "group",
            op: "or",
            children: [{ type: "cond", field: "title", op: "regex", value: "(a+)+$" }],
          },
        ],
      },
      ["children", 0, "children", 0, "value"],
      "unsafe_regex",
    ],
    [
      "invalid regex",
      { type: "cond", field: "description", op: "not_regex", value: "(" },
      ["value"],
      "unsafe_regex",
    ],
    [
      "bad duration",
      { type: "cond", field: "upload_date", op: "age_gt", value: "two weeks" },
      ["value"],
      "invalid_value",
    ],
    [
      "bad instant",
      { type: "cond", field: "last_seen", op: "before", value: "tomorrow" },
      ["value"],
      "invalid_value",
    ],
    [
      "source param on a field without one",
      { type: "cond", field: "last_seen", source: "liked", op: "is_null", value: true },
      [],
      "invalid",
    ],
    [
      "ci flag on a non-text field",
      { type: "cond", field: "channel", op: "eq", value: "UCx", ci: true },
      [],
      "invalid",
    ],
    [
      "bad first_seen source",
      { type: "cond", field: "first_seen", source: "feed", op: "is_null", value: true },
      ["source"],
      "invalid",
    ],
    ["bad group op", { type: "group", op: "xor", children: [] }, ["op"], "unknown_op"],
    ["group without children", { type: "group", op: "and" }, ["children"], "invalid"],
    [
      "extra key on a group",
      { type: "group", op: "and", children: [], negate: true },
      [],
      "invalid",
    ],
    [
      "account id not a positive int",
      { type: "cond", field: "account", op: "eq", value: 0 },
      ["value"],
      "invalid_value",
    ],
    [
      "text too long",
      { type: "cond", field: "title", op: "contains", value: "x".repeat(1001) },
      ["value"],
      "invalid_value",
    ],
  ])("%s", (_name, node, path, code) => {
    const result = validateAst(node);
    expect(result.ok).toBe(false);
    expect(result.node).toBeNull();
    expect(result.errors[0]).toMatchObject({ path, code });
    expect(result.errors[0]!.pointer).toBe(path.map((p) => `/${p}`).join(""));
    expect(result.errors[0]!.message.length).toBeGreaterThan(0);
  });

  it("reports every error, not just the first", () => {
    const result = validateAst({
      type: "group",
      op: "and",
      children: [
        { type: "cond", field: "views", op: "gt", value: "x" },
        { type: "cond", field: "likes", op: "lt", value: "y" },
      ],
    });
    expect(result.errors.map((e) => e.pointer)).toEqual(["/children/0/value", "/children/1/value"]);
  });

  it("rejects trees nested deeper than MAX_AST_DEPTH", () => {
    let node: unknown = { type: "cond", field: "views", op: "gt", value: 1 };
    for (let i = 0; i < MAX_AST_DEPTH; i++) node = { type: "group", op: "and", children: [node] };
    const result = validateAst(node);
    expect(result.errors[0]?.code).toBe("too_deep");
    expect(result.errors[0]?.path.length).toBe(MAX_AST_DEPTH * 2);
  });

  it("accepts trees exactly MAX_AST_DEPTH deep", () => {
    let node: unknown = { type: "cond", field: "views", op: "gt", value: 1 };
    for (let i = 1; i < MAX_AST_DEPTH; i++) node = { type: "group", op: "and", children: [node] };
    expect(validateAst(node).ok).toBe(true);
  });

  it("rejects a pathologically deep tree without overflowing the stack", () => {
    let node: unknown = matchAll();
    for (let i = 0; i < 100_000; i++) node = { type: "group", op: "and", children: [node] };
    expect(validateAst(node).errors[0]?.code).toBe("too_deep");
  });

  it("rejects trees with more than MAX_AST_NODES nodes", () => {
    const leafNode = { type: "cond", field: "views", op: "gt", value: 1 };
    const big = { type: "group", op: "or", children: Array(MAX_AST_NODES).fill(leafNode) };
    expect(validateAst(big).errors[0]).toMatchObject({ code: "too_many_nodes", pointer: "" });
    const ok = { type: "group", op: "or", children: Array(MAX_AST_NODES - 1).fill(leafNode) };
    expect(validateAst(ok).ok).toBe(true);
  });
});
