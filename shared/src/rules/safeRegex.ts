/**
 * Safe-regex guard for the `regex` / `not_regex` text operators.
 *
 * shared/ is synchronous and IO-free, so a real evaluation timeout is not
 * possible here. It is replaced by three layers:
 *   1. a static check that rejects the patterns behind catastrophic
 *      (exponential) backtracking: nested quantifiers such as `(a+)+` or
 *      `(a?){20}`, repeated groups with ambiguous alternation such as
 *      `(a|ab)*`, and backreferences;
 *   2. a cap on unbounded quantifiers, which bounds polynomial backtracking
 *      such as `.*.*.*x`;
 *   3. evaluation against input truncated to MAX_REGEX_INPUT characters.
 */

export const MAX_REGEX_LENGTH = 200;
/** Matched text is truncated to this many characters before testing. */
export const MAX_REGEX_INPUT = 4096;
/** Most unbounded quantifiers (`*`, `+`, `{n,}`) a pattern may contain. */
export const MAX_UNBOUNDED_QUANTIFIERS = 3;

export type RegexIssueCode =
  | "too_long"
  | "invalid"
  | "backreference"
  | "nested_quantifier"
  | "ambiguous_alternation"
  | "too_many_quantifiers";

export interface RegexIssue {
  code: RegexIssueCode;
  message: string;
}

interface Frame {
  /** Index just after the group's opening syntax (after `(` and any `?:` etc). */
  contentStart: number;
  hasQuantifier: boolean;
  hasAlternation: boolean;
}

interface Atom {
  kind: "char" | "group";
  frame?: Frame;
  content?: string;
}

interface Quantifier {
  length: number;
  /** True when the quantifier can repeat its atom more than once. */
  repeats: boolean;
  unbounded: boolean;
}

function readQuantifier(p: string, i: number): Quantifier | null {
  const c = p[i];
  let length: number;
  let repeats: boolean;
  let unbounded: boolean;
  if (c === "*" || c === "+") {
    length = 1;
    repeats = true;
    unbounded = true;
  } else if (c === "?") {
    length = 1;
    repeats = false;
    unbounded = false;
  } else if (c === "{") {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i));
    if (!m) return null;
    const min = Number(m[1]);
    const hasComma = m[2] !== undefined;
    const maxText = m[3];
    unbounded = hasComma && (maxText === undefined || maxText === "");
    const max = unbounded ? Infinity : hasComma ? Number(maxText) : min;
    length = m[0].length;
    repeats = max > 1;
  } else {
    return null;
  }
  // Lazy suffix.
  if (p[i + length] === "?") length += 1;
  return { length, repeats, unbounded };
}

const META = /[\\.[\]()*+?{}^$|]/;

/** True when every alternative is a distinct plain literal with a distinct first char. */
function alternationIsUnambiguous(content: string): boolean {
  const alternatives = content.split("|");
  const firsts = new Set<string>();
  for (const alt of alternatives) {
    if (alt === "" || META.test(alt)) return false;
    const first = alt[0]!.toLowerCase();
    if (firsts.has(first)) return false;
    firsts.add(first);
  }
  return true;
}

/** Returns null when the pattern is acceptable, else the first problem found. */
export function checkRegexSafety(pattern: string): RegexIssue | null {
  if (pattern.length > MAX_REGEX_LENGTH) {
    return { code: "too_long", message: `regex longer than ${MAX_REGEX_LENGTH} characters` };
  }
  try {
    new RegExp(pattern);
  } catch (err) {
    return { code: "invalid", message: `invalid regex: ${(err as Error).message}` };
  }

  const stack: Frame[] = [{ contentStart: 0, hasQuantifier: false, hasAlternation: false }];
  let unbounded = 0;
  let last: Atom | null = null;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    const frame = stack[stack.length - 1]!;

    const q = last ? readQuantifier(pattern, i) : null;
    if (q && last) {
      if (q.unbounded) unbounded += 1;
      if (q.repeats && last.kind === "group" && last.frame) {
        if (last.frame.hasQuantifier) {
          return {
            code: "nested_quantifier",
            message: "nested quantifiers (like (a+)+) can backtrack catastrophically",
          };
        }
        if (last.frame.hasAlternation && !alternationIsUnambiguous(last.content ?? "")) {
          return {
            code: "ambiguous_alternation",
            message:
              "a repeated group with overlapping alternatives can backtrack catastrophically",
          };
        }
      }
      frame.hasQuantifier = true;
      last = null;
      i += q.length;
      continue;
    }

    if (c === "\\") {
      const next = pattern[i + 1] ?? "";
      if (/[1-9]/.test(next) || (next === "k" && pattern[i + 2] === "<")) {
        return { code: "backreference", message: "backreferences are not allowed" };
      }
      last = { kind: "char" };
      i += 2;
      continue;
    }
    if (c === "[") {
      // Skip to the matching unescaped `]`. A `]` right after `[` or `[^` is literal.
      let j = i + 1;
      if (pattern[j] === "^") j += 1;
      if (pattern[j] === "]") j += 1;
      while (j < pattern.length && pattern[j] !== "]") j += pattern[j] === "\\" ? 2 : 1;
      last = { kind: "char" };
      i = j + 1;
      continue;
    }
    if (c === "(") {
      let start = i + 1;
      if (pattern[start] === "?") {
        const rest = pattern.slice(start);
        const m = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(rest);
        start += m ? m[0].length : 1;
      }
      stack.push({ contentStart: start, hasQuantifier: false, hasAlternation: false });
      last = null;
      i = start;
      continue;
    }
    if (c === ")") {
      const closed = stack.pop()!;
      const parent = stack[stack.length - 1];
      // Propagate conservatively: `((a+))+` and `((a|ab))+` are as bad as the flat forms.
      if (parent && closed.hasQuantifier) parent.hasQuantifier = true;
      if (parent && closed.hasAlternation) parent.hasAlternation = true;
      last = { kind: "group", frame: closed, content: pattern.slice(closed.contentStart, i) };
      i += 1;
      continue;
    }
    if (c === "|") {
      frame.hasAlternation = true;
      last = null;
      i += 1;
      continue;
    }
    if (c === "^" || c === "$") {
      last = null;
      i += 1;
      continue;
    }
    last = { kind: "char" };
    i += 1;
  }

  if (unbounded > MAX_UNBOUNDED_QUANTIFIERS) {
    return {
      code: "too_many_quantifiers",
      message: `at most ${MAX_UNBOUNDED_QUANTIFIERS} unbounded quantifiers (*, +, {n,}) are allowed`,
    };
  }
  return null;
}

/** True when `checkRegexSafety` finds no problem. */
export function isSafeRegex(pattern: string): boolean {
  return checkRegexSafety(pattern) === null;
}

const cache = new Map<string, RegExp | null>();
const CACHE_LIMIT = 512;

/**
 * Compiles a pattern after the safety check, or returns null when it is
 * unsafe or invalid. Results are memoised per pattern and flag.
 */
export function compileSafeRegex(pattern: string, caseInsensitive = false): RegExp | null {
  const key = `${caseInsensitive ? "i" : "-"}${pattern}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const re = isSafeRegex(pattern) ? new RegExp(pattern, caseInsensitive ? "i" : "") : null;
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, re);
  return re;
}

/** Tests a compiled regex against input truncated to MAX_REGEX_INPUT characters. */
export function boundedTest(re: RegExp, input: string): boolean {
  return re.test(input.length > MAX_REGEX_INPUT ? input.slice(0, MAX_REGEX_INPUT) : input);
}
