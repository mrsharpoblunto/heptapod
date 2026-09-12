#!/usr/bin/env node
import { createApiServer } from "./server.js";
const port = Number(process.env.HEPTAPOD_API_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid HEPTAPOD_API_PORT.");
const api = createApiServer({ root: process.env.HEPTAPOD_ROOT ?? process.cwd(), webOrigin: process.env.HEPTAPOD_WEB_ORIGIN ?? `http://localhost:${port - 1}` });
api.server.listen(port, "127.0.0.1", () => { process.stdout.write(`Heptapod API listening on http://127.0.0.1:${port}\n`); process.send?.({ ready: true }); });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void api.stop().finally(() => process.exit(0)); });
api.server.once("error", (error) => { process.stderr.write(`Heptapod API: ${error.message}\n`); process.exit(1); });
