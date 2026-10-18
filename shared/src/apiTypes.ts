import { z } from "zod";

/**
 * Wire contract for GET /api/status. Owned by the server, consumed by the admin
 * SPA's StatusPill and InsecureBanner. Extend, never rename, fields.
 */
export const StatusResponseSchema = z.object({
  version: z.string(),
  /** True when INSECURE_ALLOW_PUBLIC_ACCESS=1 (no auth, loopback bind). */
  insecureMode: z.boolean(),
  startedAt: z.number().int(),
  now: z.number().int(),
  db: z.object({
    ok: z.boolean(),
    migrations: z.number().int(),
  }),
  tools: z.object({
    ytdlp: z.string().nullable(),
    ffmpeg: z.string().nullable(),
  }),
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

/** Every 4xx/5xx JSON body has this shape. */
export const ApiErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
