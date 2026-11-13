import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import {
  BuiltInAgent,
  convertInputToTanStackAI,
  defineTool,
  type ToolDefinition,
} from "@copilotkit/runtime/v2";
import {
  chat,
  isContentPartArray,
  maxIterations,
  type SchemaInput,
  toolDefinition,
} from "@tanstack/ai";
import { type AnthropicChatModel, anthropicText } from "@tanstack/ai-anthropic";
import { type GeminiTextModel, geminiText } from "@tanstack/ai-gemini";
import {
  createOpenaiChatCompletions,
  type OpenAIChatModel,
  openaiChatCompletions,
  openaiText,
} from "@tanstack/ai-openai";
import { map, mergeMap, type Observable } from "rxjs";
import { z } from "zod";
import { MODEL_MAX_RETRIES } from "../config.ts";

// Same "provider/model" strings, env vars and base URL formats as the AI SDK resolver in
// @copilotkit/runtime. Each provider SDK retries transient failures up to MODEL_MAX_RETRIES times.
export function adapter(spec: string) {
  const [, provider = "", model = ""] = spec.trim().match(/^([^/:]*)[/:](.*)$/) ?? [];
  if (!provider || !model.trim())
    throw new Error(
      `Invalid model string "${spec}". Use "openai/gpt-5", "anthropic/claude-sonnet-4.5", or "google/gemini-2.5-pro".`,
    );
  const id = model.trim();
  switch (provider.toLowerCase()) {
    case "openai":
      // OpenAI-compatible endpoints that do not implement the Responses API
      // tool loop (e.g. DeepSeek) can opt into the Chat Completions wire format.
      if (process.env.OPENAI_CHAT_COMPLETIONS === "true")
        return openaiChatCompletions(id as OpenAIChatModel, {
          baseURL: process.env.OPENAI_BASE_URL,
          maxRetries: MODEL_MAX_RETRIES,
        });
      return openaiText(id as OpenAIChatModel, {
        baseURL: process.env.OPENAI_BASE_URL,
        maxRetries: MODEL_MAX_RETRIES,
      });
    case "anthropic":
      // The AI SDK base URL ends in /v1; the Anthropic SDK adds /v1 itself.
      return anthropicText(id as AnthropicChatModel, {
        baseURL: process.env.ANTHROPIC_BASE_URL?.replace(/\/v1\/?$/, ""),
        maxRetries: MODEL_MAX_RETRIES,
      });
    case "groq": {
      const apiKey = process.env.GROQ_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
      return createOpenaiChatCompletions(id as any, apiKey, {
        baseURL: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
        maxRetries: MODEL_MAX_RETRIES,
        timeout: 45000,
      });
    }
    case "kilo":
    case "kilo-auto": {
      const modelId = provider.toLowerCase() === "kilo-auto" ? `kilo-auto/${id}` : id;
      const apiKey = process.env.KILO_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
      return createOpenaiChatCompletions(modelId as any, apiKey, {
        baseURL: process.env.KILO_BASE_URL || "https://ai-gateway.kilo.ai/api/v1",
        maxRetries: MODEL_MAX_RETRIES,
        timeout: 45000,
      });
    }
    case "nvidia":
    case "nim": {
      const apiKey =
        process.env.NVIDIA_NIM_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
      return createOpenaiChatCompletions(id as any, apiKey, {
        baseURL: process.env.NVIDIA_NIM_BASE_URL || "https://integrate.api.nvidia.com/v1",
        maxRetries: MODEL_MAX_RETRIES,
        timeout: 45000,
      });
    }
    case "openrouter": {
      const apiKey =
        process.env.OPENROUTER_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
      return createOpenaiChatCompletions(id as any, apiKey, {
        baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
        maxRetries: MODEL_MAX_RETRIES,
        timeout: 45000,
      });
    }
    case "google":
      // The AI SDK base URL ends in /v1beta; @google/genai adds the API version itself.
      return geminiText(
        id as GeminiTextModel,
        {
          httpOptions: {
            baseUrl: process.env.GOOGLE_GENERATIVE_AI_BASE_URL?.replace(/\/v1beta\/?$/, ""),
            // @google/genai counts the first call in `attempts`.
            retryOptions: { attempts: MODEL_MAX_RETRIES + 1 },
          },
        } as any,
      );
    default:
      throw unknownProvider(provider, spec);
  }
}

/** Checks if an error is eligible for automated model failover (e.g. rate limits, 404s, 5xx server errors). */
export function isFailoverEligible(message: string, code?: string | number): boolean {
  const m = message.toLowerCase();
  const c = String(code ?? "").toLowerCase();
  // Client syntax errors or auth errors should fail fast
  if (c === "400" || m.includes("bad request") || m.includes("invalid parameter")) return false;
  if (c === "401" || c === "403" || m.includes("unauthorized") || m.includes("forbidden"))
    return false;

  return (
    c === "429" ||
    c === "404" ||
    c === "410" ||
    c === "402" ||
    c.startsWith("5") ||
    m.includes("rate limit") ||
    m.includes("tokens per minute") ||
    m.includes("itpm") ||
    m.includes("tpm") ||
    m.includes("not found") ||
    m.includes("does not exist") ||
    m.includes("not have access") ||
    m.includes("overloaded") ||
    m.includes("quota") ||
    m.includes("capacity") ||
    m.includes("econnreset") ||
    m.includes("etimedout") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("abort") ||
    m.includes("fetch failed") ||
    m.includes("terminated") ||
    m.includes("socket hang up")
  );
}

/** Parses comma-separated model specs and merges with optional FALLBACK_MODELS environment variable. */
export function getModelSpecs(spec?: string): string[] {
  const primaryList = (spec ?? process.env.MODEL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Fixture/test models and mock specs must not be augmented with live production fallback models
  if (primaryList.some((s) => s.includes("fixture") || s.startsWith("mock"))) {
    return primaryList;
  }

  const fallbackList = (process.env.FALLBACK_MODELS || process.env.FALLBACK_MODEL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return Array.from(new Set([...primaryList, ...fallbackList]));
}

/** Wraps multiple TanStack AI adapters in an automated, transparent failover proxy. */
export function createResilientAdapter(
  specs: string[],
  createAdapter: (spec: string) => any = adapter,
) {
  const adapters = specs.flatMap((s) => {
    try {
      return [{ spec: s, adapter: createAdapter(s) }];
    } catch (err) {
      console.warn(`[OpenMuse] Could not initialize adapter for "${s}":`, (err as any)?.message);
      return [];
    }
  });

  if (adapters.length === 0) {
    throw new Error("No model adapters could be initialized from: " + specs.join(", "));
  }

  if (adapters.length === 1) return adapters[0].adapter;

  const current = () => adapters[0].adapter;

  return new Proxy(adapters[0].adapter, {
    get(target, prop, receiver) {
      if (prop === "chatStream") {
        return async function* (options: any) {
          let activeIndex = 0;
          while (activeIndex < adapters.length) {
            const entry = adapters[activeIndex];
            const adapterInstance = entry.adapter;
            const callOptions = (adapterInstance as any).model
              ? { ...options, model: (adapterInstance as any).model }
              : options;
            let hasEmittedContent = false;
            let failed = false;
            let failureMsg = "";
            let failureCode: string | number = "";
            const buffered: any[] = [];

            try {
              for await (const chunk of (adapterInstance as any).chatStream(callOptions)) {
                if (chunk.type === "RUN_ERROR") {
                  failureMsg = chunk.message || "Unknown error";
                  failureCode = chunk.code || "";
                  failed = true;
                  break;
                }
                if (
                  chunk.type === "TEXT_MESSAGE_CONTENT" ||
                  chunk.type === "TEXT_MESSAGE_CHUNK" ||
                  chunk.type === "TOOL_CALL_START"
                ) {
                  hasEmittedContent = true;
                }
                if (!hasEmittedContent) {
                  buffered.push(chunk);
                } else {
                  while (buffered.length) yield buffered.shift();
                  yield chunk;
                }
              }
            } catch (err: any) {
              failureMsg = err.message || String(err);
              failureCode = err.status || err.code || "";
              failed = true;
            }

            if (
              failed &&
              !hasEmittedContent &&
              isFailoverEligible(failureMsg, failureCode) &&
              activeIndex + 1 < adapters.length
            ) {
              activeIndex++;
              console.warn(
                `[OpenMuse Failover] Model "${entry.spec}" failed (${failureMsg}). Trying the next configured tier...`,
              );
              continue;
            }

            while (buffered.length) yield buffered.shift();
            if (failed) yield { type: "RUN_ERROR", message: failureMsg, code: failureCode };
            return;
          }
        };
      }
      return Reflect.get(current(), prop, receiver);
    },
  });
}

export function resolveResilientAdapter(spec: string, fallbackModels?: string[]) {
  const specs = fallbackModels?.length
    ? Array.from(new Set([spec, ...fallbackModels]))
    : getModelSpecs(spec);
  return specs.length > 1 ? createResilientAdapter(specs) : adapter(specs[0] || spec);
}

/** With OPENAI_BASE_URL set, a gateway model ID most likely needs the openai/ prefix. */
export function unknownProvider(
  provider: string,
  spec: string,
  baseUrl = process.env.OPENAI_BASE_URL,
) {
  const hint = baseUrl?.trim()
    ? ` For a model on your OPENAI_BASE_URL gateway, use "openai/${spec.trim()}".`
    : "";
  return new Error(
    `Unknown provider "${provider}" in "${spec}". Supported: openai, anthropic, google (gemini), groq, kilo, nvidia (nim), openrouter.${hint}`,
  );
}

// The classic BuiltInAgent always offers these two state tools. The converter turns their
// results into STATE_SNAPSHOT / STATE_DELTA events.
const stateTools = [
  defineTool({
    name: "AGUISendStateSnapshot",
    description: "Replace the entire application state with a new snapshot",
    parameters: z.object({ snapshot: z.any().describe("The complete new state object") }),
    execute: async ({ snapshot }) => ({ success: true, snapshot }),
  }),
  defineTool({
    name: "AGUISendStateDelta",
    description: "Apply incremental updates to application state using JSON Patch operations",
    parameters: z.object({
      delta: z
        .array(
          z.object({
            op: z.enum(["add", "replace", "remove"]).describe("The operation to perform"),
            path: z.string().describe("JSON Pointer path (e.g., '/foo/bar')"),
            value: z
              .any()
              .optional()
              .describe(
                "The value to set. Required for 'add' and 'replace' operations, ignored for 'remove'.",
              ),
          }),
        )
        .describe("Array of JSON Patch operations"),
    }),
    execute: async ({ delta }) => ({ success: true, delta }),
  }),
];

/** A BuiltInAgent in TanStack factory mode with automated multi-model failover. */
export function tanstackAgent(options: {
  model: string;
  fallbackModels?: string[];
  maxSteps: number;
  tools: ToolDefinition[];
  prompt: string;
  /** Checked between model turns, after the current turn's tools have settled. */
  shouldContinue?: () => boolean;
  /** Said when the step limit, not the model, ends a run; otherwise the reply just stops. */
  stepLimitNote?: string;
}) {
  const resilientAdapter = resolveResilientAdapter(options.model, options.fallbackModels);
  const agent = new BuiltInAgent({
    type: "tanstack",
    factory: ({ input, abortController }) => {
      const converted = convertInputToTanStackAI(input);
      // Build the system prompt like the classic mode. It does not forward system messages.
      let system = options.prompt;
      if (input.context?.length) {
        system += "\n## Context from the application\n";
        for (const ctx of input.context) system += `${ctx.description}:\n${ctx.value}\n`;
      }
      if (
        input.state !== undefined &&
        input.state !== null &&
        !(typeof input.state === "object" && Object.keys(input.state).length === 0)
      )
        system += `\n## Application State\nThis is state from the application that you can edit by calling AGUISendStateSnapshot or AGUISendStateDelta.\n\`\`\`json\n${JSON.stringify(input.state, null, 2)}\n\`\`\`\n`;
      return chat({
        adapter: resilientAdapter as any,
        messages: converted.messages,
        systemPrompts: system ? [system] : [],
        tools: [
          ...converted.tools,
          ...[...options.tools, ...stateTools].map((tool) =>
            toolDefinition({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.parameters as SchemaInput,
            }).server((args) => (tool.execute as (args: unknown) => Promise<unknown>)(args)),
          ),
        ],
        agentLoopStrategy: (state) =>
          maxIterations(options.maxSteps)(state) && (options.shouldContinue?.() ?? true),
        abortController,
      });
    },
  });
  const run = agent.run.bind(agent);
  agent.run = (input: RunAgentInput) => {
    const events = splitTextAtToolCalls(run(input)).pipe(map(textOnlyToolResult));
    return options.stepLimitNote
      ? reportStepLimit(events, options.maxSteps, options.stepLimitNote)
      : events;
  };
  return agent;
}

/**
 * A tool can return TanStack content parts, e.g. text plus a screenshot. Inside the run
 * the adapters send them to the model as multimodal tool results. The AG-UI result event
 * would carry the same parts JSON-encoded, image data included, into the stored thread,
 * and later turns replay that history as plain text. Keep only the text parts there.
 */
export function textOnlyToolResult(event: BaseEvent): BaseEvent {
  if (event.type !== EventType.TOOL_CALL_RESULT) return event;
  const content = (event as { content?: unknown }).content;
  if (typeof content !== "string" || !content.startsWith("[")) return event;
  let parts: unknown;
  try {
    parts = JSON.parse(content);
  } catch {
    return event;
  }
  if (!isContentPartArray(parts)) return event;
  const text = (parts as any[]).flatMap((part: any) =>
    part?.type === "text" ? [part.content || part.text || ""] : [],
  );
  return { ...event, content: text.join("\n") } as BaseEvent;
}

/**
 * maxIterations ends the loop after the last allowed tool step without a final model reply.
 * When a run ends that way, add a short assistant message so it does not stop silently.
 */
export function reportStepLimit(events: Observable<BaseEvent>, maxSteps: number, note: string) {
  let steps = 0;
  let phase: "text" | "calling" | "results" = "text";
  return events.pipe(
    mergeMap((event): BaseEvent[] => {
      if (event.type === EventType.TOOL_CALL_START) {
        // Parallel calls of one model step arrive together; results end the step.
        if (phase !== "calling") steps++;
        phase = "calling";
      } else if (event.type === EventType.TOOL_CALL_RESULT) phase = "results";
      else if (event.type === EventType.TEXT_MESSAGE_CHUNK) phase = "text";
      else if (event.type === EventType.RUN_FINISHED && phase === "results" && steps >= maxSteps)
        return [
          {
            type: EventType.TEXT_MESSAGE_CHUNK,
            messageId: randomUUID(),
            role: "assistant",
            delta: note,
          } as BaseEvent,
          event,
        ];
      return [event];
    }),
  );
}

// ponytail: the TanStack converter in @copilotkit/runtime 1.70.1 uses one message ID for the
// whole run. Remove this when it starts a new ID for each step, like the classic mode does.
// Text after a tool call gets a new message ID, so each step's text is a separate message.
function splitTextAtToolCalls(events: Observable<BaseEvent>) {
  let messageId: string | undefined;
  let afterToolCall = false;
  return events.pipe(
    map((event) => {
      if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
        if (!messageId || afterToolCall) messageId = randomUUID();
        afterToolCall = false;
        return { ...event, messageId };
      }
      if (event.type === EventType.TOOL_CALL_START) {
        afterToolCall = true;
        return messageId ? { ...event, parentMessageId: messageId } : event;
      }
      if (event.type === EventType.TOOL_CALL_RESULT) afterToolCall = true;
      return event;
    }),
  );
}
