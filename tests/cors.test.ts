import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { type Config, readConfig } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let db: Store;
let app: Awaited<ReturnType<typeof createApp>>["app"];
let directory: string;

const vercelOrigin = "https://gangniaga-openmuse.vercel.app";
const untrustedOrigin = "https://malicious-attacker.com";

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-cors-"));
  db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081", vercelOrigin],
  };
  ({ app } = await createApp(db, config));
});

after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("OPTIONS /api/health allows configured Vercel origin with 204 and CORS headers", async () => {
  const response = await app.request("/api/health", {
    method: "OPTIONS",
    headers: {
      Origin: vercelOrigin,
      "Access-Control-Request-Method": "GET",
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), vercelOrigin);
  assert.match(response.headers.get("access-control-allow-methods") ?? "", /GET/);
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
});

test("OPTIONS /api/health rejects untrusted origin with 403 and omits allow-origin", async () => {
  const response = await app.request("/api/health", {
    method: "OPTIONS",
    headers: {
      Origin: untrustedOrigin,
      "Access-Control-Request-Method": "GET",
    },
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("GET /api/health includes access-control-allow-origin for trusted origin", async () => {
  const response = await app.request("/api/health", {
    method: "GET",
    headers: { Origin: vercelOrigin },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), vercelOrigin);
});

test("GET /api/health returns 403 for untrusted origin", async () => {
  const response = await app.request("/api/health", {
    method: "GET",
    headers: { Origin: untrustedOrigin },
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("readConfig parses ALLOWED_ORIGINS and trims whitespace", () => {
  const oldEnv = { ...process.env };
  try {
    process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
    process.env.ALLOWED_ORIGINS =
      " http://localhost:8081 , https://gangniaga-openmuse.vercel.app , ";
    const config = readConfig();
    assert.deepEqual(config.allowedOrigins, [
      "http://localhost:8081",
      "https://gangniaga-openmuse.vercel.app",
    ]);
  } finally {
    process.env = oldEnv;
  }
});

test("readConfig supports CORS_ORIGIN alias when ALLOWED_ORIGINS is unset", () => {
  const oldEnv = { ...process.env };
  try {
    process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
    delete process.env.ALLOWED_ORIGINS;
    process.env.CORS_ORIGIN = "https://gangniaga-openmuse.vercel.app";
    const config = readConfig();
    assert.deepEqual(config.allowedOrigins, ["https://gangniaga-openmuse.vercel.app"]);
  } finally {
    process.env = oldEnv;
  }
});
