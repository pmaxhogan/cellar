import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  createAccount,
  deleteAccount,
  listAccounts,
  setCookies,
  updateAccount,
} from "../domain/accounts.ts";
import { completeOAuth, OAuthFailure, startOAuth } from "../youtube/oauth.ts";
import { IntIdParamsSchema, routeDeps, type Wave1ARouteOptions } from "./routeDeps.ts";
import { parseBody, parseParams, parseQuery } from "./validate.ts";

const CreateAccountSchema = z.strictObject({
  label: z.string().trim().max(100).optional(),
});

const UpdateAccountSchema = z.strictObject({
  label: z.string().trim().min(1).max(100).optional(),
  status: z.enum(["disabled", "pending"]).optional(),
  scrape_budget_per_hour: z.number().int().min(0).max(100_000).nullable().optional(),
});

/** 1 MiB of cookies is far beyond any real jar. */
const CookiesSchema = z.strictObject({
  cookies: z
    .string()
    .min(1)
    .max(1024 * 1024),
});

const StartQuerySchema = z.object({ account: z.coerce.number().int().positive() });

const CallbackQuerySchema = z.object({
  code: z.string().max(4096).optional(),
  state: z.string().max(512).optional(),
  error: z.string().max(256).optional(),
});

/**
 * /api/accounts plus the Google OAuth start and callback. The callback never
 * answers with an error body: the browser is mid-redirect, so every outcome
 * is a 302 back to the Accounts page with a short code.
 */
export const accountRoutes: FastifyPluginAsync<Wave1ARouteOptions> = async (app, options) => {
  const deps = routeDeps(app, options, "accounts");

  app.get("/accounts", () => ({ rows: listAccounts(deps.db) }));

  app.post("/accounts", async (request, reply) => {
    const body = parseBody(CreateAccountSchema, request);
    return reply.code(201).send(createAccount(deps.db, body.label ?? ""));
  });

  const update = (request: Parameters<typeof parseBody>[1]) => {
    const { id } = parseParams(IntIdParamsSchema, request);
    return updateAccount(deps.db, id, parseBody(UpdateAccountSchema, request));
  };
  app.put("/accounts/:id", (request) => update(request));
  app.patch("/accounts/:id", (request) => update(request));

  app.delete("/accounts/:id", async (request, reply) => {
    const { id } = parseParams(IntIdParamsSchema, request);
    deleteAccount(deps.db, id);
    return reply.code(204).send();
  });

  app.post("/accounts/:id/cookies", async (request) => {
    const { id } = parseParams(IntIdParamsSchema, request);
    const { cookies } = parseBody(CookiesSchema, request);
    return setCookies(deps, id, cookies);
  });

  app.get("/oauth/google/start", async (request, reply) => {
    const { account } = parseQuery(StartQuerySchema, request);
    return reply.redirect(startOAuth(deps, account), 302);
  });

  app.get("/oauth/google/callback", async (request, reply) => {
    const parsed = CallbackQuerySchema.safeParse(request.query);
    try {
      if (!parsed.success) {
        throw new OAuthFailure("state");
      }
      const accountId = await completeOAuth(deps, parsed.data);
      return await reply.redirect(`/accounts?linked=${String(accountId)}`, 302);
    } catch (error) {
      const code = error instanceof OAuthFailure ? error.code : "internal";
      if (!(error instanceof OAuthFailure)) {
        request.log.error({ err: error }, "oauth callback failed");
      }
      return reply.redirect(`/accounts?error=${encodeURIComponent(code)}`, 302);
    }
  });
};
