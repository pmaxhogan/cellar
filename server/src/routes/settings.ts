import type { SettingsResponse } from "@cellar/shared";
import type { FastifyPluginAsync } from "fastify";
import { getSettingsOverrides, updateSettings } from "../domain/settings.ts";

/**
 * The body of PUT /api/settings is the SettingsPatch itself. A body of the
 * form `{ patch: {...} }` is accepted too; no setting is named `patch`, so
 * the two shapes cannot be confused.
 */
function patchFromBody(body: unknown): unknown {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const keys = Object.keys(body);
    const inner = (body as { patch?: unknown }).patch;
    if (keys.length === 1 && keys[0] === "patch" && typeof inner === "object" && inner !== null) {
      return inner;
    }
  }
  return body ?? {};
}

/** /api/settings: sparse overrides in, sparse overrides out. */
export const settingsRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.cellar;

  app.get("/settings", (): SettingsResponse => ({ overrides: getSettingsOverrides(db) }));

  app.put("/settings", (request): SettingsResponse => ({
    overrides: updateSettings(db, patchFromBody(request.body)),
  }));
};
