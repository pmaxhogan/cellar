import Fastify from "fastify";
import { CELLAR_VERSION } from "@cellar/shared";

// Placeholder entrypoint: replaced by the walking skeleton (config -> logger -> db -> app).
const app = Fastify({ logger: false });
app.get("/healthz", async () => ({ ok: true, version: CELLAR_VERSION }));
const port = Number(process.env["PORT"] ?? 8080);
const host = process.env["INSECURE_ALLOW_PUBLIC_ACCESS"] === "1" ? "127.0.0.1" : "0.0.0.0";
await app.listen({ port, host });
