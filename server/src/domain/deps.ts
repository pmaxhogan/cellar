import type { Logger } from "pino";
import type { Config } from "../config.ts";
import type { Db } from "../db/db.ts";
import { isUsableSecretKey } from "../security/secrets.ts";
import { DomainError } from "./errors.ts";

/** The subset of fetch the server uses; tests inject a fake with this shape. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * What the account, quota, proxy and settings services need. Route plugins
 * build one from the app context; jobs and the self-check build their own.
 * Everything with IO beyond the database is injectable for tests.
 */
export interface ServiceDeps {
  config: Config;
  db: Db;
  log: Logger;
  /** Outbound HTTP to Google. Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Clock in epoch ms. Defaults to Date.now. */
  now?: () => number;
}

export function nowOf(deps: Pick<ServiceDeps, "now">): number {
  return deps.now === undefined ? Date.now() : deps.now();
}

export function fetchOf(deps: Pick<ServiceDeps, "fetch">): FetchLike {
  return deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
}

/**
 * The AES key, or a 412 with a fixed message. A missing key is an operator
 * problem the UI can explain; it must not surface as a generic 500.
 */
export function requireSecretKey(config: Pick<Config, "secretKey">): Buffer {
  if (!isUsableSecretKey(config.secretKey)) {
    throw new DomainError(
      "precondition_failed",
      "CELLAR_SECRET_KEY is not configured, so credentials cannot be stored or read.",
    );
  }
  return config.secretKey;
}
