import type { ApiError } from "@cellar/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { DomainError } from "../domain/errors.ts";

/**
 * Route level validation. Bodies, queries, and params are parsed with the zod
 * schemas from shared/src/apiTypes.ts, so the wire contract has exactly one
 * definition and the client infers its types from the same file.
 */

function issueDetails(error: z.ZodError): { fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".");
    fields[path === "" ? "(root)" : path] = issue.message;
  }
  return { fields };
}

function parse<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }
  const details = issueDetails(result.error);
  // Name the offending fields (schema paths only, never the rejected values) so
  // the message the UI shows says what to fix.
  const names = Object.keys(details.fields).filter((name) => name !== "(root)");
  const suffix = names.length === 0 ? "" : `: ${names.join(", ")}`;
  throw new DomainError("invalid", `Invalid ${what}${suffix}.`, details);
}

export function parseBody<T>(schema: z.ZodType<T>, request: FastifyRequest): T {
  return parse(schema, request.body ?? {}, "request body");
}

export function parseQuery<T>(schema: z.ZodType<T>, request: FastifyRequest): T {
  return parse(schema, request.query ?? {}, "query string");
}

export function parseParams<T>(schema: z.ZodType<T>, request: FastifyRequest): T {
  return parse(schema, request.params ?? {}, "path");
}

/** The fixed 5xx body. Nothing about the real failure reaches the client. */
export const INTERNAL_ERROR: ApiError = { error: "internal error", code: "internal" };

/**
 * Translate a thrown error into the shared ApiError shape: `error` is the human
 * readable message, `code` the machine readable one.
 *
 * Only 4xx messages are passed through. A 5xx is reported as a fixed string
 * and the real error goes to the log instead, because an unexpected failure
 * can carry anything in its message and API responses must never become a
 * side channel for it.
 */
export function toApiError(error: unknown): { status: number; body: ApiError } {
  if (error instanceof DomainError) {
    return {
      status: error.status,
      body: {
        error: error.message,
        code: error.code,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }

  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    const code = (error as { code?: unknown }).code;
    return {
      status,
      body: {
        error: error instanceof Error ? error.message : "The request could not be processed.",
        code: typeof code === "string" ? code : "bad_request",
      },
    };
  }

  return { status: 500, body: INTERNAL_ERROR };
}

export function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  const { status, body } = toApiError(error);
  return reply.code(status).send(body);
}
