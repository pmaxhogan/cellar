import { CELLAR_VERSION } from "@cellar/shared";

/**
 * Injected at image build time (docker build --build-arg CELLAR_VERSION). Falls
 * back to the workspace version for local runs.
 */
export const APP_VERSION = process.env["CELLAR_VERSION"] || CELLAR_VERSION;
