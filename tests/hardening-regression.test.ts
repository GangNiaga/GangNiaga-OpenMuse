import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalComputer } from "../apps/server/src/computer-backend.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createResilientAdapter } from "../apps/server/src/engine/tanstack-agent.ts";
import { validatePublicUrl } from "../apps/worker/src/network.ts";

test("network validation pins an IP family and rejects mixed public/private answers", async () => {
  const target = await validatePublicUrl("https://example.test", async () => [
    { address: "8.8.8.8", family: 4 },
  ]);
  assert.equal(target.family, 4);
  await assert.rejects(
    validatePublicUrl("https://example.test", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.2", family: 4 },
    ]),
  );
  await assert.rejects(validatePublicUrl("https://example.test", async () => []));
});

test("local workspace creates nested files but rejects symlink escape", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-hardening-"));
  const outside = await mkdtemp(join(tmpdir(), "openmuse-outside-"));
  t.after(() =>
    Promise.all([
      rm(dir, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]),
  );
  const backend = new LocalComputer({ dataDir: dir } as Config);
  const session = await backend.running("owner");
  const written = await session.file(
    JSON.stringify({ operation: "write", path: "/workspace/nested/new.txt", text: "safe" }),
    5,
    4096,
  );
  assert.equal(written.exitCode, 0, written.stderr);
  assert.equal(await readFile(join(dir, "workspace/nested/new.txt"), "utf8"), "safe");
  await symlink(
    outside,
    join(dir, "workspace/escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const escaped = await session.file(
    JSON.stringify({ operation: "write", path: "/workspace/escape/file.txt", text: "unsafe" }),
    5,
    4096,
  );
  assert.equal(escaped.exitCode, 1);
});

test("failover advances once per tier and restarts the primary for the next stream", async () => {
  const calls: string[] = [];
  const adapter = createResilientAdapter(["primary/model", "fallback/model"], (spec) => ({
    async *chatStream() {
      calls.push(spec);
      if (calls.length > 5) throw new Error("failover did not advance");
      if (spec.startsWith("primary"))
        yield { type: "RUN_ERROR", message: "429 rate limit", code: 429 };
      else yield { type: "TEXT_MESSAGE_CONTENT", delta: "ok" };
    },
  }));
  for (let i = 0; i < 2; i++) {
    const chunks = [];
    for await (const chunk of adapter.chatStream({})) chunks.push(chunk);
    assert.equal(chunks[0]?.delta, "ok");
  }
  assert.deepEqual(calls, ["primary/model", "fallback/model", "primary/model", "fallback/model"]);
});

test("Obscura child environment excludes application credentials", async () => {
  const { obscuraEnvironment } = await import("../apps/server/src/obscura.ts");
  const env = obscuraEnvironment({
    PATH: "fixture",
    DATABASE_URL: "private",
    OPENAI_API_KEY: "private",
    OBSCURA_ALLOW_PRIVATE_NETWORK: "1",
  });
  assert.equal(env.PATH, "fixture");
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.OBSCURA_ALLOW_PRIVATE_NETWORK, "0");
});

test("Obscura fetch stops its child process when the request is cancelled", async (t) => {
  const { obscuraFetch } = await import("../apps/server/src/obscura.ts");
  const directory = await mkdtemp(join(tmpdir(), "openmuse-obscura-cancel-"));
  const binary = join(
    directory,
    process.platform === "win32" ? "mock-obscura.cmd" : "mock-obscura",
  );
  await writeFile(
    binary,
    process.platform === "win32"
      ? "@echo off\r\nping -n 31 127.0.0.1 >nul\r\n"
      : "#!/bin/sh\nsleep 30\n",
    { mode: 0o755 },
  );
  const previous = process.env.OBSCURA_BIN;
  process.env.OBSCURA_BIN = binary;
  t.after(async () => {
    if (previous === undefined) delete process.env.OBSCURA_BIN;
    else process.env.OBSCURA_BIN = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const controller = new AbortController();
  const pending = obscuraFetch({
    url: "https://example.com",
    dump: "markdown",
    stealth: true,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /abort|cancel/i);
});

for (const partial of [false, true])
  test(`failover refuses ${partial ? "retry after visible output" : "authentication errors"}`, async () => {
    const calls: string[] = [];
    const adapter = createResilientAdapter(["primary/model", "fallback/model"], (spec) => ({
      async *chatStream() {
        calls.push(spec);
        if (partial)
          yield { type: "TOOL_CALL_START", toolCallId: "once", toolCallName: "write_record" };
        yield {
          type: "RUN_ERROR",
          message: partial ? "rate limit" : "unauthorized",
          code: partial ? 429 : 401,
        };
      },
    }));
    const chunks = [];
    for await (const chunk of adapter.chatStream({})) chunks.push(chunk);
    assert.deepEqual(calls, ["primary/model"]);
    assert.equal(chunks.at(-1)?.type, "RUN_ERROR");
  });

test("exhausted model tiers emit one terminal failure", async () => {
  let calls = 0;
  const adapter = createResilientAdapter(["primary/model", "fallback/model"], () => ({
    // biome-ignore lint/correctness/useYield: Exercise a provider that throws before its first chunk.
    async *chatStream() {
      calls++;
      throw new Error("429 rate limit");
    },
  }));
  const chunks = [];
  for await (const chunk of adapter.chatStream({})) chunks.push(chunk);
  assert.equal(calls, 2);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].type, "RUN_ERROR");
});
