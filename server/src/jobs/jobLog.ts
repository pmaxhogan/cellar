import pino, { type DestinationStream, type Logger } from "pino";
import { baseLoggerOptions } from "../logging.ts";

export const JOB_LOG_FILE = "job.log";

export interface JobLogger {
  log: Logger;
  /** Flush and close job.log. The main log stream is left open. */
  close(): void;
}

/**
 * A logger that writes to the main log (whatever streams `parent` writes to,
 * at the parent's level) and to `file` at debug level, so the per-job file
 * carries the detail the main log filters out. Redaction is the same as the
 * main logger's because both are built from baseLoggerOptions.
 */
export function createJobLogger(
  parent: Logger,
  file: string,
  bindings: Record<string, unknown>,
): JobLogger {
  const fileStream = pino.destination({ dest: file, sync: true, mkdir: true, append: true });
  const streams: pino.StreamEntry[] = [{ level: "debug", stream: fileStream }];

  const parentLevel = parent.level;
  const parentStream = (parent as unknown as Record<symbol, DestinationStream | undefined>)[
    pino.symbols.streamSym
  ];
  if (parentLevel !== "silent" && parentStream !== undefined) {
    streams.push({ level: parentLevel as pino.Level, stream: parentStream });
  }
  const level = parentLevel === "trace" ? "trace" : "debug";

  const options = baseLoggerOptions(level);
  const log = pino(
    { ...options, base: { ...(options.base ?? {}), mod: "jobs", ...bindings } },
    pino.multistream(streams),
  );

  let closed = false;
  return {
    log,
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      try {
        fileStream.flushSync();
      } catch {
        // Nothing buffered, or the fd is already gone.
      }
      fileStream.end();
    },
  };
}
