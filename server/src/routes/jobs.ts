import {
  ActionNameSchema,
  ActivityQuerySchema,
  JobsQuerySchema,
  type ActionResponse,
  type ActivityListResponse,
  type JobLogFilesResponse,
  type JobRow,
  type JobsListResponse,
} from "@cellar/shared";
import type { FastifyPluginAsync } from "fastify";
import { createReadStream, readdirSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { z } from "zod";
import { listActivity } from "../domain/activity.ts";
import { invalid, notFound } from "../domain/errors.ts";
import { JobQueue, toJobRow } from "../jobs/queue.ts";
import { jobRegistry, type JobRegistry } from "../jobs/types.ts";
import { parseParams, parseQuery } from "./validate.ts";

/**
 * /api/jobs, /api/activity and /api/actions. Routes never hold a reference to
 * the scheduler: a cancel is a status change on the row plus a job.cancelled
 * event, and the scheduler aborts the worker when it sees either.
 */

export interface JobRoutesOptions {
  registry?: JobRegistry;
}

/** A log file name: one path segment of safe characters, never "." or "..". */
export const LOG_FILE_NAME = /^[A-Za-z0-9._-]+$/;

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const LogFileParams = z.object({
  id: z.coerce.number().int().positive(),
  name: z.string().max(255).regex(LOG_FILE_NAME, "Not a valid log file name."),
});
const ActionParams = z.object({ name: z.string() });

export function jobLogDir(logsDir: string, id: number): string {
  return join(logsDir, "jobs", String(id));
}

function statOrUndefined(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

export const jobRoutes: FastifyPluginAsync<JobRoutesOptions> = async (app, options) => {
  const { db, events, config } = app.cellar;
  const registry = options.registry ?? jobRegistry;
  const queue = new JobQueue(db, { registry, events });

  const requireJob = (id: number): JobRow => {
    const job = queue.get(id);
    if (job === undefined) {
      throw notFound("Job", id);
    }
    return toJobRow(job);
  };

  app.get("/jobs", (request): JobsListResponse => {
    const query = parseQuery(JobsQuerySchema, request);
    return queue.list(query);
  });

  app.get("/jobs/:id", (request): JobRow => {
    const { id } = parseParams(IdParams, request);
    return requireJob(id);
  });

  app.post("/jobs/:id/cancel", (request): JobRow => {
    const { id } = parseParams(IdParams, request);
    return toJobRow(queue.cancel(id));
  });

  app.post("/jobs/:id/retry", (request): JobRow => {
    const { id } = parseParams(IdParams, request);
    return toJobRow(queue.retry(id));
  });

  app.get("/jobs/:id/log", (request): JobLogFilesResponse => {
    const { id } = parseParams(IdParams, request);
    requireJob(id);
    const dir = jobLogDir(config.logsDir, id);
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && LOG_FILE_NAME.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return { files: [] };
    }
    const files: JobLogFilesResponse["files"] = [];
    for (const name of names) {
      const stats = statOrUndefined(join(dir, name));
      if (stats !== undefined) {
        files.push({ name, size: stats.size });
      }
    }
    return { files };
  });

  app.get("/jobs/:id/log/:name", async (request, reply) => {
    const { id, name } = parseParams(LogFileParams, request);
    if (name === "." || name === "..") {
      throw invalid("Not a valid log file name.");
    }
    requireJob(id);
    const file = join(jobLogDir(config.logsDir, id), name);
    if (statOrUndefined(file)?.isFile() !== true) {
      throw notFound("Log file", name);
    }
    const stream = createReadStream(file);
    const body = name.endsWith(".gz") ? stream.pipe(createGunzip()) : stream;
    if (body !== stream) {
      stream.on("error", (error) => body.destroy(error));
    }
    return reply
      .type("text/plain; charset=utf-8")
      .header("x-content-type-options", "nosniff")
      .send(body);
  });

  app.get("/activity", (request): ActivityListResponse => {
    const query = parseQuery(ActivityQuerySchema, request);
    return listActivity(db, {
      page: query.page,
      perPage: query.perPage,
      level: query.level,
      kind: query.kind,
      videoId: query.video_id,
    });
  });

  app.post("/actions/:name", async (request, reply) => {
    const params = parseParams(ActionParams, request);
    const parsed = ActionNameSchema.safeParse(params.name);
    if (!parsed.success) {
      throw notFound("Action", params.name);
    }
    const type = `action:${parsed.data}`;
    if (!registry.has(type)) {
      return reply.code(501).send({
        error: `The ${parsed.data} action is not available yet.`,
        code: "not_implemented",
      });
    }
    const { id } = queue.enqueue({ type, dedupe: true, priority: 10 });
    const body: ActionResponse = { job_id: id };
    return reply.code(202).send(body);
  });
};
