import type { StatusResponse } from "@cellar/shared";
import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../db/db.ts";
import { readToolVersions } from "../media/tools.ts";

/** Database health: a trivial query succeeds, plus how many migrations are applied. */
function dbStatus(db: Db): StatusResponse["db"] {
  try {
    db.get("SELECT 1");
    const row = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM migrations");
    return { ok: true, migrations: Number(row?.n ?? 0) };
  } catch {
    return { ok: false, migrations: 0 };
  }
}

/**
 * GET /api/status.
 *
 * insecureMode is the important field: the web UI renders it as a permanent
 * undismissable banner, so it is reported straight from the config rather than
 * inferred from anything the request could influence.
 */
export const statusRoutes: FastifyPluginAsync = async (app) => {
  const { db, config, version, startedAt } = app.cellar;

  app.get("/status", (): StatusResponse => {
    const tools = readToolVersions(db);
    return {
      version,
      insecureMode: config.insecureMode,
      startedAt,
      now: Date.now(),
      db: dbStatus(db),
      tools: { ytdlp: tools.ytdlp, ffmpeg: tools.ffmpeg },
    };
  });
};
