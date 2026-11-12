import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { openbotTools } from "../apps/server/src/openbot.ts";

async function createMockServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let data = "";
      req.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      req.on("end", () => {
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch {
          parsed = data;
        }
        handler(req, res, parsed);
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function makeConfig(directory: string, overrides: Partial<Config> = {}): Config {
  return {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-intelligence-key",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
    ...overrides,
  };
}

test("Test 1: When openbotEnabled: true and mock OpenBot server responds, /api/workspace reports connected and /api/openbot/status is reachable", async () => {
  const { server, port } = await createMockServer((req, res) => {
    assert.equal(
      req.headers.authorization,
      undefined,
      "Authorization header must not be forwarded to OpenBot",
    );
    assert.equal(req.headers.cookie, undefined, "Cookie header must not be forwarded to OpenBot");
    if (req.url === "/api/capabilities" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          mode: "intelligence",
          durableHistory: true,
          generativeUi: true,
        }),
      );
      return;
    }
    if (req.url === "/api/me" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ user: { id: "openbot-user-1" } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const directory = await mkdtemp(join(tmpdir(), "openmuse-openbot-t1-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const config = makeConfig(directory, {
    openbotEnabled: true,
    openbotUrl: `http://127.0.0.1:${port}`,
  });
  const { app, agent } = await createApp(db, config);

  try {
    const healthRes = await app.request("/api/health");
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.openbotReachable, true);

    const signInRes = await app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(signInRes.status, 200);
    const { token } = await signInRes.json();
    const headers = { Authorization: `Bearer ${token}` };

    const workspaceRes = await app.request("/api/workspace", { headers });
    assert.equal(workspaceRes.status, 200);
    const workspace = await workspaceRes.json();
    const openbotConn = workspace.connections.find((c: { id: string }) => c.id === "openbot");
    assert.ok(openbotConn, "openbot connection must be present");
    assert.equal(openbotConn.status, "connected");

    const statusRes = await app.request("/api/openbot/status", { headers });
    assert.equal(statusRes.status, 200);
    const status = await statusRes.json();
    assert.equal(status.enabled, true);
    assert.equal(status.reachable, true);
    assert.equal(status.probe.state, "authenticated");
    assert.equal(status.probe.userId, "openbot-user-1");
    assert.equal(status.probe.mode, "intelligence");
  } finally {
    await agent.stop();
    await db.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Test 2: When openbotEnabled: true and openbotUrl is unreachable, /api/workspace downgrades connection to unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-openbot-t2-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const config = makeConfig(directory, {
    openbotEnabled: true,
    openbotUrl: "http://127.0.0.1:59998",
  });
  const { app, agent } = await createApp(db, config);

  try {
    const healthRes = await app.request("/api/health");
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.openbotReachable, false);

    const signInRes = await app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const { token } = await signInRes.json();
    const headers = { Authorization: `Bearer ${token}` };

    const workspaceRes = await app.request("/api/workspace", { headers });
    assert.equal(workspaceRes.status, 200);
    const workspace = await workspaceRes.json();
    const openbotConn = workspace.connections.find((c: { id: string }) => c.id === "openbot");
    assert.ok(openbotConn, "openbot connection must be present");
    assert.equal(openbotConn.status, "unavailable");

    const statusRes = await app.request("/api/openbot/status", { headers });
    assert.equal(statusRes.status, 200);
    const status = await statusRes.json();
    assert.equal(status.enabled, true);
    assert.equal(status.reachable, false);
    assert.equal(status.probe.state, "unavailable");
  } finally {
    await agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Test 3: POST /api/openbot/computers/:botId/navigate and POST /api/openbot/channels dispatch through OpenBotAdapter", async () => {
  const { server, port } = await createMockServer((req, res, body) => {
    assert.equal(
      req.headers.authorization,
      undefined,
      "Authorization header must not be forwarded to OpenBot in Test 3",
    );
    assert.equal(
      req.headers.cookie,
      undefined,
      "Cookie header must not be forwarded to OpenBot in Test 3",
    );
    if (req.url === "/api/capabilities" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          mode: "intelligence",
          durableHistory: true,
          generativeUi: true,
        }),
      );
      return;
    }
    if (req.url === "/api/channels" && req.method === "POST") {
      assert.deepEqual(body, { agentIds: ["bot-agent-7"] });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          channel: {
            id: "chan-777",
            threadId: "thread-777",
            agentIds: ["bot-agent-7"],
          },
        }),
      );
      return;
    }
    if (req.url === "/api/computers/bot-99/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ botId: "bot-99", state: "ready" }));
      return;
    }
    if (req.url === "/api/computers/bot-99/snapshot" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          snapshotId: 101,
          url: "https://gangniaga.com/dashboard",
          title: "GangNiaga Dashboard",
          truncated: false,
          elements: [{ ref: "btn-1", role: "button", name: "Submit" }],
        }),
      );
      return;
    }
    if (req.url === "/api/computers/bot-99/navigate" && req.method === "POST") {
      const parsedBody = body as { url?: string; toolCallId?: string } | null;
      assert.equal(parsedBody?.url, "https://gangniaga.com/settings");
      assert.equal(parsedBody?.toolCallId, "call-123");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          url: "https://gangniaga.com/settings",
          title: "Settings",
          text: "Configured settings",
          truncated: false,
          elapsedMs: 85,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const directory = await mkdtemp(join(tmpdir(), "openmuse-openbot-t3-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const config = makeConfig(directory, {
    openbotEnabled: true,
    openbotUrl: `http://127.0.0.1:${port}`,
    openbotAgentId: "bot-agent-7",
  });
  const { app, agent, openbot } = await createApp(db, config);

  try {
    const signInRes = await app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const { token } = await signInRes.json();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const chanRes = await app.request("/api/openbot/channels", {
      method: "POST",
      headers,
      body: JSON.stringify({ agentId: "bot-agent-7" }),
    });
    assert.equal(chanRes.status, 201);
    const channel = await chanRes.json();
    assert.equal(channel.channelId, "chan-777");
    assert.equal(channel.threadId, "thread-777");
    assert.deepEqual(channel.agentIds, ["bot-agent-7"]);

    const compStatusRes = await app.request("/api/openbot/computers/bot-99/status", { headers });
    assert.equal(compStatusRes.status, 200);
    const compStatus = await compStatusRes.json();
    assert.equal(compStatus.botId, "bot-99");
    assert.equal(compStatus.state, "ready");

    const snapRes = await app.request("/api/openbot/computers/bot-99/snapshot", {
      method: "POST",
      headers,
    });
    assert.equal(snapRes.status, 200);
    const snap = await snapRes.json();
    assert.equal(snap.snapshotId, 101);
    assert.equal(snap.url, "https://gangniaga.com/dashboard");
    assert.equal(snap.elements.length, 1);

    const navRes = await app.request("/api/openbot/computers/bot-99/navigate", {
      method: "POST",
      headers,
      body: JSON.stringify({
        url: "https://gangniaga.com/settings",
        toolCallId: "call-123",
      }),
    });
    assert.equal(navRes.status, 200);
    const nav = await navRes.json();
    assert.equal(nav.url, "https://gangniaga.com/settings");
    assert.equal(nav.title, "Settings");
    assert.equal(nav.elapsedMs, 85);

    const tools = openbotTools(openbot);
    assert.equal(tools.length, 3);
    const [statusTool, navTool, snapTool] = tools;
    assert.equal(statusTool.name, "openbot_status");
    assert.equal(navTool.name, "openbot_computer_navigate");
    assert.equal(snapTool.name, "openbot_computer_snapshot");

    type ToolNavFn = (args: {
      botId: string;
      url: string;
      toolCallId?: string;
    }) => Promise<{ url: string }>;
    const toolNavResult = await (navTool.execute as unknown as ToolNavFn)({
      botId: "bot-99",
      url: "https://gangniaga.com/settings",
      toolCallId: "call-123",
    });
    assert.equal(toolNavResult.url, "https://gangniaga.com/settings");

    type ToolSnapFn = (args: { botId: string }) => Promise<{ snapshotId: number }>;
    const toolSnapResult = await (snapTool.execute as unknown as ToolSnapFn)({ botId: "bot-99" });
    assert.equal(toolSnapResult.snapshotId, 101);
  } finally {
    await agent.stop();
    await db.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Test 4: /api/openbot/status is protected by authentication middleware and rejects unauthenticated callers with 401", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-openbot-t4-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const config = makeConfig(directory, {
    openbotEnabled: true,
    openbotUrl: "http://127.0.0.1:3001",
  });
  const { app, agent } = await createApp(db, config);

  try {
    const unauthRes = await app.request("/api/openbot/status");
    assert.equal(unauthRes.status, 401);
  } finally {
    await agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
