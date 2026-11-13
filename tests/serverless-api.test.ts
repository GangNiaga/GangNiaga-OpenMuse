import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { assertServerlessConfig, createServerlessHandler } from "../api/_handler.ts";
import type { Config } from "../apps/server/src/config.ts";

test("serverless requires live mode and an explicit database", () => {
  assert.throws(() => assertServerlessConfig({ mode: "sample" } as Config), /live/);
  assert.throws(() => assertServerlessConfig({ mode: "live" } as Config), /DATABASE_URL/);
});
test("initialization failure is private and a later request can retry", async () => {
  let attempts = 0;
  const app = new Hono();
  app.get("/api", (c) => c.json({ status: "online" }));
  const handler = createServerlessHandler(async () => {
    if (++attempts === 1) throw new Error("password=must-not-leak");
    return app;
  });
  const first = await handler(new Request("https://example.test/api"));
  assert.equal(first?.status, 503);
  assert.ok(first);
  assert.doesNotMatch(await first.text(), /must-not-leak|stack|password/);
  assert.equal((await handler(new Request("https://example.test/api")))?.status, 200);
  assert.equal(attempts, 2);
});
test("concurrent cold requests share initialization", async () => {
  let attempts = 0;
  const app = new Hono();
  app.get("/api", (c) => c.json({ ok: true }));
  const handler = createServerlessHandler(async () => {
    attempts++;
    return app;
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => handler(new Request("https://example.test/api"))),
  );
  assert.equal(attempts, 1);
  assert.ok(results.every((r) => r?.status === 200));
});

test("a failed response that already sent headers is closed without appending JSON", async () => {
  const handler = createServerlessHandler(async () => {
    throw new Error("fixture");
  });
  let destroyed = false;
  const response = {
    headersSent: true,
    writableEnded: false,
    destroyed: false,
    destroy() {
      destroyed = true;
    },
    end() {
      throw new Error("must not append fallback");
    },
  };
  await handler(
    {} as import("node:http").IncomingMessage,
    response as unknown as import("node:http").ServerResponse,
  );
  assert.equal(destroyed, true);
});
