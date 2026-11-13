import assert from "node:assert/strict";
import { test } from "node:test";
import { chat, toolDefinition } from "@tanstack/ai";
import { z } from "zod";
import { createResilientAdapter, getModelSpecs } from "../apps/server/src/engine/tanstack-agent.ts";

test("getModelSpecs parses comma-separated models and merges fallback env", () => {
  const prevFallback = process.env.FALLBACK_MODELS;
  try {
    delete process.env.FALLBACK_MODELS;
    const specs = getModelSpecs("groq/qwen/qwen3.8-27b, kilo/kilo-auto/free");
    assert.deepEqual(specs, ["groq/qwen/qwen3.8-27b", "kilo/kilo-auto/free"]);
  } finally {
    if (prevFallback !== undefined) process.env.FALLBACK_MODELS = prevFallback;
  }
});

test("createResilientAdapter resets to the first tier for each new agent selection", async () => {
  let primaryCalled = 0;
  let fallbackCalled = 0;

  const mockPrimary = {
    model: "primary-model",
    kind: "chat",
    name: "mock-primary",
    async *chatStream() {
      primaryCalled++;
      yield {
        type: "RUN_ERROR",
        message: "429 Rate limit reached on input tokens per minute (ITPM)",
        code: "rate_limit_exceeded",
      };
    },
  };

  const mockFallback = {
    model: "fallback-model",
    kind: "chat",
    name: "mock-fallback",
    async *chatStream(options: any) {
      fallbackCalled++;
      yield {
        type: "RUN_STARTED",
        runId: "run-fb",
        threadId: options.threadId ?? "thread-fb",
      };
      yield {
        type: "TEXT_MESSAGE_START",
        messageId: "msg-1",
      };
      yield {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "msg-1",
        delta: "Hello from resilient fallback!",
      };
      yield {
        type: "TEXT_MESSAGE_END",
        messageId: "msg-1",
      };
      yield {
        type: "RUN_FINISHED",
        runId: "run-fb",
      };
    },
  };

  const resilient = createResilientAdapter(["primary/model", "fallback/model"], (spec) =>
    spec.startsWith("primary/") ? mockPrimary : mockFallback,
  );

  async function run() {
    const stream = await chat({
      adapter: resilient as any,
      messages: [{ role: "user", content: "Test failover" }],
    });
    let fullText = "";
    for await (const chunk of stream) {
      if (chunk.type === "TEXT_MESSAGE_CONTENT" && chunk.delta) fullText += chunk.delta;
    }
    return fullText;
  }

  assert.equal(await run(), "Hello from resilient fallback!");
  assert.equal(await run(), "Hello from resilient fallback!");
  assert.equal(primaryCalled, 2, "Each agent selection starts at the first tier");
  assert.equal(fallbackCalled, 2, "Failover still runs after the first tier fails");
});
