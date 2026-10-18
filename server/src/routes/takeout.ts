import multipart from "@fastify/multipart";
import {
  TAKEOUT_MAX_UPLOAD_BYTES,
  TakeoutUploadQuerySchema,
  type TakeoutJobResponse,
  type TakeoutUploadResponse,
} from "@cellar/shared";
import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError, notFound } from "../domain/errors.ts";
import {
  ByteBudget,
  createStagingDir,
  MAX_SKIPPED_LISTED,
  planStaging,
  removeStagingDir,
  saveUpload,
  systemTar,
  TAKEOUT_JOB,
  takeoutStatus,
  TakeoutUploadError,
  tooLarge,
  type SavedUpload,
  type TakeoutPayload,
  type TarRunner,
} from "../domain/takeout.ts";
import { JobQueue } from "../jobs/queue.ts";
import { jobRegistry, type JobRegistry } from "../jobs/types.ts";
import { parseParams, parseQuery } from "./validate.ts";

/**
 * POST /api/takeout and GET /api/takeout/:jobId. @fastify/multipart is
 * registered inside this plugin only, so no other route accepts multipart
 * bodies. Uploads stream to disk under $DATA_DIR/tmp/takeout-<id>/; nothing is
 * buffered in memory.
 */

export interface TakeoutRoutesOptions {
  /** Defaults to the process-wide jobRegistry. */
  registry?: JobRegistry;
  /** Test seam; defaults to TAKEOUT_MAX_UPLOAD_BYTES (2 GB). */
  maxUploadBytes?: number;
  /** Test seam; defaults to the system tar. */
  tar?: TarRunner;
}

/** Most files one upload may carry (a Takeout with many playlists uploaded loose). */
export const MAX_UPLOAD_FILES = 500;

const JobParams = z.object({ jobId: z.coerce.number().int().positive() });

function accountFrom(value: unknown): number | null {
  const parsed = TakeoutUploadQuerySchema.safeParse({ account_id: value });
  return parsed.success ? parsed.data.account_id : null;
}

export const takeoutRoutes: FastifyPluginAsync<TakeoutRoutesOptions> = async (app, options) => {
  const { db, events, config } = app.cellar;
  const registry = options.registry ?? jobRegistry;
  const queue = new JobQueue(db, { registry, events });
  const maxBytes = options.maxUploadBytes ?? TAKEOUT_MAX_UPLOAD_BYTES;
  const tar = options.tar ?? systemTar();
  const accountExists = (id: number): boolean =>
    db.get("SELECT id FROM accounts WHERE id = ?", id) !== undefined;

  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: {
      fileSize: maxBytes,
      files: MAX_UPLOAD_FILES,
      fields: 10,
      parts: MAX_UPLOAD_FILES + 10,
    },
  });

  app.post("/takeout", async (request, reply) => {
    if (!request.isMultipart()) {
      throw new DomainError("invalid", "Send the files as multipart/form-data.");
    }
    const query = request.query as Record<string, unknown> | undefined;
    let accountId: number | null =
      query?.account_id === undefined
        ? null
        : parseQuery(TakeoutUploadQuerySchema, request).account_id;
    // Checked before the body is read, so a wrong id does not cost a large upload first.
    if (accountId !== null && !accountExists(accountId)) {
      throw notFound("Account", accountId);
    }

    const dir = await createStagingDir(config.tmpDir, randomUUID());
    try {
      const budget = new ByteBudget(maxBytes);
      const uploads: SavedUpload[] = [];
      try {
        for await (const part of request.parts()) {
          if (part.type === "file") {
            uploads.push(await saveUpload(dir, uploads.length, part.filename, part.file, budget));
            if (part.file.truncated) {
              throw tooLarge(maxBytes);
            }
          } else if (part.fieldname === "account_id" && accountId === null) {
            accountId = accountFrom(part.value);
            if (accountId === null) {
              throw new DomainError("invalid", "account_id must be a positive integer.", {
                fields: { account_id: "Must be a positive integer" },
              });
            }
          }
        }
      } catch (error) {
        if ((error as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE") {
          throw tooLarge(maxBytes);
        }
        throw error;
      }

      if (accountId === null) {
        throw new DomainError("invalid", "Choose the account to import into (account_id).", {
          fields: { account_id: "Required" },
        });
      }
      if (!accountExists(accountId)) {
        throw notFound("Account", accountId);
      }
      if (uploads.length === 0) {
        throw new TakeoutUploadError("no_files", "The upload carried no files.");
      }

      const plan = await planStaging(dir, uploads, tar);
      const payload: TakeoutPayload = { dir, files: plan.files, account_id: accountId };
      const job = queue.enqueue({ type: TAKEOUT_JOB, payload });
      request.log.info(
        { jobId: job.id, files: plan.files.length, skipped: plan.skipped.length },
        "takeout upload staged",
      );
      const body: TakeoutUploadResponse = {
        job_id: job.id,
        files: plan.preview,
        skipped: plan.skipped.slice(0, MAX_SKIPPED_LISTED),
        skipped_total: plan.skipped.length,
      };
      return await reply.code(202).send(body);
    } catch (error) {
      await removeStagingDir(config.tmpDir, dir);
      throw error;
    }
  });

  app.get("/takeout/:jobId", (request): TakeoutJobResponse => {
    const { jobId } = parseParams(JobParams, request);
    return takeoutStatus(db, jobId);
  });
};
