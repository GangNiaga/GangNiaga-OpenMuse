import assert from "node:assert/strict";
import test from "node:test";
import type { Auth } from "../apps/server/src/auth.ts";
import { BrowserService } from "../apps/server/src/browser.ts";
import type { Config } from "../apps/server/src/config.ts";
import type { Store } from "../apps/server/src/db.ts";
import type { Files } from "../apps/server/src/files.ts";

test("pool diagnostics use authenticated worker inventory and disclose failure", async (t) => {
  const service = new BrowserService(
    {} as Store,
    { workerUrl: "https://worker.invalid", workerToken: "fixture" } as Config,
    {} as Auth,
    {} as Files,
  );
  const fetch = t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture");
    return Response.json([{ id: "private-id", status: "active" }, { status: "closed" }]);
  });
  assert.deepEqual(await service.poolStatus(), {
    configured: true,
    reachable: true,
    activeSessions: 1,
  });
  fetch.mock.mockImplementation(async () => {
    throw new Error("unreachable");
  });
  assert.deepEqual(await service.poolStatus(), {
    configured: true,
    reachable: false,
    activeSessions: null,
  });
  const unconfigured = new BrowserService({} as Store, {} as Config, {} as Auth, {} as Files);
  assert.deepEqual(await unconfigured.poolStatus(), {
    configured: false,
    reachable: null,
    activeSessions: null,
  });
});
