import { spawn, spawnSync } from "node:child_process";
import { resolveToolCommand, type ToolName } from "./tools.ts";

/**
 * Streaming tool runner for the media pipeline. The built-in runTool
 * (media/tools.ts) buffers output until exit, but downloads and transcodes
 * need their progress lines as they arrive, and must stop when the job is
 * cancelled. Always an argv array, never a shell. The argv is never logged
 * here; callers log a redacted copy.
 */

export interface SpawnToolRequest {
  tool: ToolName;
  args: readonly string[];
  /** Kill the process after this long. Default: no timeout. */
  timeoutMs?: number;
  cwd?: string;
  /** Extra environment merged over the runner's base environment. */
  env?: Readonly<Record<string, string>>;
  /** Abort kills the process (SIGTERM, then SIGKILL after a grace period). */
  signal?: AbortSignal;
  /** Run under `nice -n <nice>` when a `nice` binary is on PATH. */
  nice?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface SpawnToolResult {
  /** Exit code, or null when the process was killed (timeout, abort, signal). */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export type SpawnTool = (request: SpawnToolRequest) => Promise<SpawnToolResult>;

export interface SpawnToolOptions {
  binDir: string;
  /** Base environment for children and for CELLAR_TOOL_* lookups. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: whether `nice` can be used. Default: probed once on PATH. */
  hasNice?: () => boolean;
  /** Grace between SIGTERM and SIGKILL. Default 5 s. */
  killGraceMs?: number;
  /** Cap on the captured stdout/stderr text (each); older text is dropped. Default 8 MiB. */
  maxCaptureBytes?: number;
}

const DEFAULT_KILL_GRACE_MS = 5000;
const DEFAULT_MAX_CAPTURE = 8 * 1024 * 1024;

let niceProbe: boolean | undefined;

/** Whether `nice` runs here. Probed once per process. */
export function niceAvailable(): boolean {
  if (niceProbe === undefined) {
    if (process.platform === "win32") {
      niceProbe = false;
    } else {
      const result = spawnSync("nice", ["-n", "0", "true"], { stdio: "ignore", timeout: 5000 });
      niceProbe = result.error === undefined && result.status === 0;
    }
  }
  return niceProbe;
}

/** Tests only. */
export function resetNiceProbe(): void {
  niceProbe = undefined;
}

/** The argv a request runs as: optional nice prefix, the resolved tool, then the args. */
export function buildToolArgv(
  request: Pick<SpawnToolRequest, "tool" | "args" | "nice">,
  options: Pick<SpawnToolOptions, "binDir" | "env" | "hasNice">,
): [string, ...string[]] {
  const env = options.env ?? process.env;
  const command = resolveToolCommand(request.tool, options.binDir, env);
  const argv: string[] = [...command, ...request.args];
  const hasNice = options.hasNice ?? niceAvailable;
  if (request.nice !== undefined && hasNice()) {
    argv.unshift("nice", "-n", String(request.nice));
  }
  return argv as [string, ...string[]];
}

/** Split a byte stream into lines on \n, \r\n and bare \r (ffmpeg and progress bars use \r). */
export class LineSplitter {
  #buffer = "";
  readonly #emit: (line: string) => void;

  constructor(emit: (line: string) => void) {
    this.#emit = emit;
  }

  push(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.#buffer);
      if (match === null) {
        return;
      }
      // A trailing \r might be the first half of \r\n: wait for more input.
      if (match[0] === "\r" && match.index === this.#buffer.length - 1) {
        return;
      }
      const line = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      this.#emit(line);
    }
  }

  end(): void {
    const rest = this.#buffer.replace(/\r$/, "");
    this.#buffer = "";
    if (rest !== "") {
      this.#emit(rest);
    }
  }
}

function appendCapped(current: string, chunk: string, cap: number): string {
  const next = current + chunk;
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Build the streaming runner. */
export function createSpawnTool(options: SpawnToolOptions): SpawnTool {
  const killGrace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const cap = options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE;

  return (request) =>
    new Promise<SpawnToolResult>((resolvePromise, reject) => {
      const [command, ...args] = buildToolArgv(request, options);
      if (request.signal?.aborted === true) {
        resolvePromise({ code: null, stdout: "", stderr: "", timedOut: false, aborted: true });
        return;
      }
      const child = spawn(command, args, {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...(options.env ?? process.env), ...request.env },
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = false;
      let killTimer: NodeJS.Timeout | undefined;
      let settled = false;

      const outLines = new LineSplitter((line) => request.onStdoutLine?.(line));
      const errLines = new LineSplitter((line) => request.onStderrLine?.(line));
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = appendCapped(stdout, chunk, cap);
        outLines.push(chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = appendCapped(stderr, chunk, cap);
        errLines.push(chunk);
      });

      const kill = (): void => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, killGrace);
        killTimer.unref();
      };

      const timeout =
        request.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              kill();
            }, request.timeoutMs);
      timeout?.unref();

      const onAbort = (): void => {
        aborted = true;
        kill();
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = (): void => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        if (killTimer !== undefined) {
          clearTimeout(killTimer);
        }
        request.signal?.removeEventListener("abort", onAbort);
      };

      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        outLines.end();
        errLines.end();
        resolvePromise({
          code: timedOut || aborted ? null : code,
          stdout,
          stderr,
          timedOut,
          aborted,
        });
      });
    });
}
