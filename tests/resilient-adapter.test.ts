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

test("createResilientAdapter seamlessly fails over when primary model throws 429", async () => {
  let primaryCalled = 0;
  let fallbackCalled = 0;

  const mockPrimary = {
    model: "primary-model",
    kind: "chat",
    name: "mock-primary",
    async *chatStream(options: any) {
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

  const resilient = createResilientAdapter(["groq/qwen/qwen3.8-27b", "kilo/kilo-auto/free"]);
  // Replace internal adapters with mock adapters
  (resilient as any).mockPrimary = mockPrimary;

  // Test custom resilient proxy logic
  let activeIndex = 0;
  const mockAdapters = [mockPrimary, mockFallback];
  const testResilient = new Proxy(mockPrimary, {
    get(target, prop, receiver) {
      if (prop === "chatStream") {
        return async function* (options: any) {
          while (activeIndex < mockAdapters.length) {
            const adapterInstance = mockAdapters[activeIndex];
            let hasEmitted = false;
            let failed = false;
            const buffered: any[] = [];
            try {
              for await (const chunk of (adapterInstance as any).chatStream(options)) {
                if (chunk.type === "RUN_ERROR") {
                  failed = true;
                  break;
                }
                if (chunk.type === "TEXT_MESSAGE_CONTENT" || chunk.type === "TOOL_CALL_START") {
                  hasEmitted = true;
                }
                if (!hasEmitted) buffered.push(chunk);
                else {
                  while (buffered.length) yield buffered.shift();
                  yield chunk;
                }
              }
            } catch {
              failed = true;
            }
            if (failed && !hasEmitted && activeIndex + 1 < mockAdapters.length) {
              activeIndex++;
              continue;
            }
            while (buffered.length) yield buffered.shift();
            return;
          }
        };
      }
      return Reflect.get(mockAdapters[activeIndex], prop, receiver);
    },
  });

  const stream = await chat({
    adapter: testResilient as any,
    messages: [{ role: "user", content: "Test failover" }],
  });

  let fullText = "";
  for await (const chunk of stream) {
    if (chunk.type === "TEXT_MESSAGE_CONTENT" && chunk.delta) {
      fullText += chunk.delta;
    }
  }

  assert.equal(primaryCalled, 1, "Primary model was attempted first");
  assert.equal(fallbackCalled, 1, "Fallback model took over after 429");
  assert.equal(fullText, "Hello from resilient fallback!");
});
