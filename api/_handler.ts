import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";

type Application = { fetch(request: Request): Response | Promise<Response> };

import { createApp } from "../apps/server/src/app.js";
import { type Config, readConfig } from "../apps/server/src/config.js";
import { createStore } from "../apps/server/src/db.js";

export const runtime = "nodejs";
export function assertServerlessConfig(config: Config): void {
  if (config.mode !== "live") throw new Error("Serverless deployments require WORKSPACE_MODE=live");
  if (!config.databaseUrl?.trim()) throw new Error("Serverless deployments require DATABASE_URL");
  if (config.computerEnabled && !config.computerDeploymentId)
    throw new Error("Serverless computer execution requires COMPUTER_DEPLOYMENT_ID");
}
async function initialize(): Promise<Application> {
  const config = readConfig();
  assertServerlessConfig(config);
  config.taskWorkerEnabled = false;
  config.dataDir = process.env.DATA_DIR || "/tmp/openmuse";
  const db = await createStore({ databaseUrl: config.databaseUrl });
  try {
    return (await createApp(db, config)).app;
  } catch (error) {
    await db.close();
    throw error;
  }
  // A cold instance cannot declare another instance's executing actions interrupted.
}
export function createServerlessHandler(init: () => Promise<Application>) {
  let initialized: Promise<Application> | undefined;
  return async (
    req: Request | IncomingMessage,
    res?: ServerResponse,
  ): Promise<Response | undefined> => {
    try {
      if (!initialized) {
        initialized = init().catch((error) => {
          initialized = undefined;
          throw error;
        });
      }
      const app = await initialized;
      if (res) {
        await getRequestListener(app.fetch)(req as IncomingMessage, res);
        return;
      }
      return await app.fetch(req as Request);
    } catch {
      const requestId = randomUUID();
      console.error(JSON.stringify({ event: "serverless_request_failed", requestId }));
      const body = JSON.stringify({ error: "Service temporarily unavailable", requestId });
      const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
      if (res) {
        if (res.writableEnded || res.destroyed) return;
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(503, headers);
        res.end(body);
        return;
      }
      return new Response(body, { status: 503, headers });
    }
  };
}
const handler = createServerlessHandler(initialize);
export default handler;
export const GET = handler,
  POST = handler,
  PUT = handler,
  DELETE = handler,
  PATCH = handler,
  OPTIONS = handler,
  HEAD = handler;
