import assert from "node:assert/strict";
import { test } from "node:test";
import handler from "../api/_handler.ts";

interface ApiInfo {
  name: string;
  status: string;
}

interface HealthInfo {
  ok: boolean;
  mode?: string;
}

interface SessionInfo {
  token: string;
  mode?: string;
}

interface WorkspaceInfo {
  connections: unknown[];
}

test("Vercel Serverless API: /api returns service status and runtime", async () => {
  const req = new Request("http://localhost:8787/api", {
    method: "GET",
  });
  const res = await handler(req);
  assert.ok(res instanceof Response);
  assert.equal(res.status, 200);
  const data = (await res.json()) as ApiInfo;
  assert.equal(data.name, "OpenMuse API");
  assert.equal(data.status, "online");
});

test("Vercel Serverless API: /api/health returns system health report", async () => {
  const req = new Request("http://localhost:8787/api/health", {
    method: "GET",
  });
  const res = await handler(req);
  assert.ok(res instanceof Response);
  assert.equal(res.status, 200);
  const data = (await res.json()) as HealthInfo;
  assert.equal(data.ok, true);
  assert.ok(data.mode);
});

test("Vercel Serverless API: /api/session creates a valid session token", async () => {
  const req = new Request("http://localhost:8787/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey: "test-serverless" }),
  });
  const res = await handler(req);
  assert.ok(res instanceof Response);
  assert.equal(res.status, 200);
  const session = (await res.json()) as SessionInfo;
  assert.ok(session.token);
  assert.ok(typeof session.token === "string");

  // Verify that subsequent workspace request with token succeeds
  const wsReq = new Request("http://localhost:8787/api/workspace", {
    method: "GET",
    headers: { Authorization: `Bearer ${session.token}` },
  });
  const wsRes = await handler(wsReq);
  assert.ok(wsRes instanceof Response);
  assert.equal(wsRes.status, 200);
  const wsData = (await wsRes.json()) as WorkspaceInfo;
  assert.ok(Array.isArray(wsData.connections));
});
