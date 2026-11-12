import type { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type { Hono } from "hono";
import { createApp } from "../apps/server/src/app.ts";
import { readConfig } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";

export const runtime = "nodejs";

let cachedApp: Hono<{ Variables: { owner: string } }> | null = null;
let initPromise: Promise<Hono<{ Variables: { owner: string } }>> | null = null;

export async function getApp(): Promise<Hono<{ Variables: { owner: string } }>> {
  if (cachedApp) return cachedApp;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!process.env.CPK_INTELLIGENCE_API_KEY) {
      process.env.CPK_INTELLIGENCE_API_KEY = "serverless-key-placeholder";
    }
    const config = readConfig();
    config.taskWorkerEnabled = false;

    const dataDir = process.env.DATA_DIR || "/tmp/openmuse";
    const databaseUrl =
      process.env.DATABASE_URL ||
      config.databaseUrl ||
      "postgres://postgres.wmuxfyymcgapqcyznltp:gangniagabot2026@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres";

    const db = await createStore({
      dataDir: `${dataDir}/postgres`,
      databaseUrl,
    });

    await db.recoverInterruptedActions().catch(() => {});
    const { app } = await createApp(db, config);

    cachedApp = app;
    return app;
  })();

  return initPromise;
}

export default async function handler(
  req: Request | IncomingMessage,
  res?: ServerResponse,
): Promise<Response | undefined> {
  try {
    const app = await getApp();
    if (res && typeof res.writeHead === "function") {
      await getRequestListener(app.fetch)(req as IncomingMessage, res);
      return;
    }
    return app.fetch(req as Request);
  } catch (err: unknown) {
    console.error("[Serverless Init Error]:", err);
    const errorMsg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const body = JSON.stringify({
      error: "Serverless initialization failed",
      message: errorMsg,
      stack,
    });
    if (res && typeof res.writeHead === "function") {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(body);
      return;
    }
    return new Response(body, {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export const GET = (req: Request) => handler(req);
export const POST = (req: Request) => handler(req);
export const PUT = (req: Request) => handler(req);
export const DELETE = (req: Request) => handler(req);
export const PATCH = (req: Request) => handler(req);
export const OPTIONS = (req: Request) => handler(req);
export const HEAD = (req: Request) => handler(req);
