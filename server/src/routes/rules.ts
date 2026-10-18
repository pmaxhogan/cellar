import type { RulePreview, RuleRow, RulesListResponse } from "@cellar/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { mutationDeps, previewCondition, type RulesDeps } from "../domain/ruleEval.ts";
import { createRule, deleteRule, listRules, reorderRules, updateRule } from "../domain/rules.ts";
import { parseBody, parseParams } from "./validate.ts";

/**
 * /api/rules (contract in shared/src/apiTypes.ts "Rules API"). PATCH
 * /api/rules/:id is accepted as an alias of PUT because docs/ARCHITECTURE.md
 * names PATCH; both take a full RuleDraft.
 */

export interface RulesRoutesOptions {
  deps: RulesDeps;
}

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const OrderBody = z.object({ ids: z.array(z.number().int().positive()).max(10_000) });
const PreviewBody = z.object({ condition: z.unknown() });

export const rulesRoutes: FastifyPluginAsync<RulesRoutesOptions> = async (app, options) => {
  const { deps } = options;
  const mutate = mutationDeps(deps);

  app.get("/rules", (): RulesListResponse => ({ rows: listRules(deps.db) }));

  app.post("/rules", async (request, reply) => {
    const row: RuleRow = createRule(mutate, request.body);
    return reply.code(201).send(row);
  });

  app.put("/rules/order", (request): RulesListResponse => {
    const { ids } = parseBody(OrderBody, request);
    return { rows: reorderRules(mutate, ids) };
  });

  app.post("/rules/preview", (request): RulePreview => {
    const { condition } = parseBody(PreviewBody, request);
    return previewCondition(deps, condition);
  });

  const update = (request: FastifyRequest): RuleRow => {
    const { id } = parseParams(IdParams, request);
    return updateRule(mutate, id, request.body);
  };
  app.put("/rules/:id", update);
  app.patch("/rules/:id", update);

  app.delete("/rules/:id", async (request, reply) => {
    const { id } = parseParams(IdParams, request);
    deleteRule(mutate, id);
    return reply.code(204).send();
  });
};
