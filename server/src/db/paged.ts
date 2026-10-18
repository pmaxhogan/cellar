import type { SQLInputValue } from "node:sqlite";
import type { Db } from "./db.ts";

/** The `{ rows, total, page, perPage }` envelope every list endpoint answers. */
export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  perPage: number;
}

/** A WHERE clause assembled from optional filters; empty when nothing applies. */
export class Where {
  readonly #clauses: string[] = [];
  readonly #params: SQLInputValue[] = [];

  /** Add `clause` (with `?` placeholders) only when `value` is defined. */
  maybe(clause: string, value: SQLInputValue | undefined): this {
    if (value !== undefined) {
      this.#clauses.push(clause);
      this.#params.push(value);
    }
    return this;
  }

  add(clause: string, ...params: SQLInputValue[]): this {
    this.#clauses.push(clause);
    this.#params.push(...params);
    return this;
  }

  get sql(): string {
    return this.#clauses.length === 0 ? "" : `WHERE ${this.#clauses.join(" AND ")}`;
  }

  get params(): SQLInputValue[] {
    return [...this.#params];
  }
}

/**
 * Run a paged query. `from` is the table expression, `orderBy` the ORDER BY
 * body; both are code constants, never request input.
 */
export function pagedQuery<R, T>(
  db: Db,
  options: {
    select: string;
    from: string;
    where: Where;
    orderBy: string;
    page: number;
    perPage: number;
    map: (row: R) => T;
  },
): Paged<T> {
  const { where, page, perPage } = options;
  const total = Number(
    db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${options.from} ${where.sql}`, ...where.params)
      ?.n ?? 0,
  );
  const rows = db.all<R>(
    `SELECT ${options.select} FROM ${options.from} ${where.sql}
     ORDER BY ${options.orderBy} LIMIT ? OFFSET ?`,
    ...where.params,
    perPage,
    (page - 1) * perPage,
  );
  return { rows: rows.map(options.map), total, page, perPage };
}

/** Escape LIKE wildcards so user text matches literally (used with ESCAPE '\'). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Parse a nullable *_json column; a malformed value reads as null. */
export function parseJsonColumn(value: string | null): unknown {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
