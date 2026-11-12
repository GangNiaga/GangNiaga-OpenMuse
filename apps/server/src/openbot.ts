import { defineTool, type ToolDefinition } from "@copilotkit/runtime/v2";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import {
  OpenBotAdapter,
  OpenBotError,
  type OpenBotProbe,
  type OpenBotTransport,
  withTimeoutSignal,
} from "../../../packages/backends/src/openbot.ts";
import type { Config } from "./config.ts";

export class OpenBotService {
  readonly url: string;
  readonly agentId: string;
  private healthCache?: { checkedAt: number; reachable: Promise<boolean> };
  private readonly authValidator?: (authHeader: string) => Promise<boolean>;
  private readonly timeoutMs: number;

  constructor(
    readonly config: Config,
    private readonly now: () => number = Date.now,
    authValidator?: (authHeader: string) => Promise<boolean>,
  ) {
    this.url = (config?.openbotUrl || config?.openbotBaseUrl || "http://127.0.0.1:3001").replace(
      /\/+$/,
      "",
    );
    this.agentId = config?.openbotAgentId || "assistant";
    this.authValidator = authValidator;
    this.timeoutMs = config?.openbotTimeout ?? 2500;
  }

  private async validateAuth(authHeader: string): Promise<boolean> {
    if (!this.authValidator) return true;
    return this.authValidator(authHeader);
  }

  /**
   * Probes ${this.url}/api/capabilities with a timeout.
   * Returns true only if this.config.openbotEnabled is true AND
   * /api/capabilities returns HTTP 200 with valid JSON (mode === "intelligence").
   */
  async reachable(signal?: AbortSignal): Promise<boolean> {
    if (!this.config?.openbotEnabled) return false;
    const now = this.now();
    if (this.healthCache && now - this.healthCache.checkedAt < 5_000) {
      return this.healthCache.reachable;
    }
    const check = async () => {
      try {
        const timeoutSignal = withTimeoutSignal(signal, this.timeoutMs);
        const combinedSignal = timeoutSignal;
        const res = await fetch(`${this.url}/api/capabilities`, {
          signal: combinedSignal,
          headers: { Accept: "application/json" },
        });
        if (!res.ok) return false;
        const data = (await res.json().catch(() => null)) as { mode?: string } | null;
        return data?.mode === "intelligence";
      } catch {
        return false;
      }
    };
    const reachablePromise = check();
    this.healthCache = { checkedAt: now, reachable: reachablePromise };
    return reachablePromise;
  }

  /**
   * Constructs OpenBotAdapter with a real fetch-based OpenBotTransport.
   * Strips caller session Authorization / Cookie headers to prevent credential leaking
   * across trust boundaries to OpenBot.
   */
  adapter(): OpenBotAdapter {
    const transport: OpenBotTransport = {
      runtimeUrl: `${this.url}${this.config?.openbotRuntimePath || "/api/copilotkit"}`,
      request: async (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        headers.delete("Authorization");
        headers.delete("Cookie");
        const targetUrl = new URL(path, this.url).toString();
        return fetch(targetUrl, {
          ...init,
          headers,
        });
      },
    };

    return new OpenBotAdapter({
      enabled: this.config?.openbotEnabled,
      agentId: this.agentId,
      transport,
    });
  }

  /**
   * Calls this.adapter().probe(signal) plus /api/capabilities reachability.
   * Validates authHeader against OpenMuse identity if authValidator is configured.
   * Distinguishes: abort before dispatch => zero remote requests;
   * abort after dispatch => outcomeUnknown preserved.
   * Token OpenMuse tidak dianggap sesi OpenBot — hanya OpenMuse session userId boleh dipaparkan.
   */
  async probe(
    authHeader?: string,
    signal?: AbortSignal,
  ): Promise<{ reachable: boolean; probe: OpenBotProbe }> {
    const reachable = await this.reachable(signal);
    if (!this.config?.openbotEnabled) {
      return { reachable: false, probe: { state: "disabled" } };
    }
    if (!reachable) {
      return {
        reachable: false,
        probe: { state: "unavailable", reason: `OpenBot endpoint ${this.url} is unreachable` },
      };
    }
    // Validate authHeader against OpenMuse identity (not OpenBot session)
    if (authHeader) {
      const valid = await this.validateAuth(authHeader);
      if (!valid) {
        return {
          reachable: true,
          probe: { state: "authentication_required" },
        };
      }
    }
    const adapter = this.adapter();
    const probe = await adapter.probe(withTimeoutSignal(signal, this.timeoutMs));
    return { reachable, probe };
  }
}

export function openbotRoutes(openbot: OpenBotService) {
  const router = new Hono();

  router.get("/status", async (c) => {
    const authHeader = c.req.header("authorization");
    const result = await openbot.probe(authHeader);
    return c.json({
      enabled: Boolean(openbot.config?.openbotEnabled),
      runtimeUrl: `${openbot.url}${openbot.config?.openbotRuntimePath || "/api/copilotkit"}`,
      agentId: openbot.agentId,
      reachable: result.reachable,
      probe: result.probe,
    });
  });

  router.post("/channels", async (c) => {
    let agentId = openbot.agentId;
    try {
      const body = await c.req.json();
      if (body && typeof body.agentId === "string" && body.agentId.trim()) {
        agentId = body.agentId.trim();
      }
    } catch {
      // body optional
    }
    const adapter = openbot.adapter();
    try {
      const result = await adapter.createConversation(agentId);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof OpenBotError) {
        const { status: statusCode, outcomeUnknown, rule } = mapErrorStatus(err);
        return c.json({ error: err.message, code: err.code, outcomeUnknown, rule }, statusCode);
      }
      throw err;
    }
  });

  router.get("/computers/:botId/status", async (c) => {
    const botId = c.req.param("botId");
    const adapter = openbot.adapter();
    try {
      const result = await adapter.computerStatus(botId);
      return c.json(result);
    } catch (err) {
      if (err instanceof OpenBotError) {
        const { status: statusCode, outcomeUnknown, rule } = mapErrorStatus(err);
        return c.json({ error: err.message, code: err.code, outcomeUnknown, rule }, statusCode);
      }
      throw err;
    }
  });

  router.post("/computers/:botId/snapshot", async (c) => {
    const botId = c.req.param("botId");
    const adapter = openbot.adapter();
    try {
      const result = await adapter.snapshot(botId);
      return c.json(result);
    } catch (err) {
      if (err instanceof OpenBotError) {
        const { status: statusCode, outcomeUnknown, rule } = mapErrorStatus(err);
        return c.json({ error: err.message, code: err.code, outcomeUnknown, rule }, statusCode);
      }
      throw err;
    }
  });

  router.post("/computers/:botId/navigate", async (c) => {
    const botId = c.req.param("botId");
    const body = z
      .object({
        url: z.string(),
        toolCallId: z.string().optional(),
      })
      .parse(await c.req.json());
    const adapter = openbot.adapter();
    try {
      const result = await adapter.navigate(botId, body);
      return c.json(result);
    } catch (err) {
      if (err instanceof OpenBotError) {
        const { status: statusCode, outcomeUnknown, rule } = mapErrorStatus(err);
        return c.json({ error: err.message, code: err.code, outcomeUnknown, rule }, statusCode);
      }
      throw err;
    }
  });

  return router;
}

function mapErrorStatus(err: OpenBotError): {
  status: ContentfulStatusCode;
  outcomeUnknown: boolean;
  rule?: string;
} {
  if (err.status && err.status >= 400 && err.status < 600) {
    return {
      status: err.status as ContentfulStatusCode,
      outcomeUnknown: !!err.outcomeUnknown,
      rule: err.rule,
    };
  }
  switch (err.code) {
    case "authentication_required":
      return { status: 401, outcomeUnknown: false, rule: err.rule };
    case "refused":
      return { status: 403, outcomeUnknown: false, rule: err.rule };
    case "invalid_input":
      return { status: 422, outcomeUnknown: false, rule: err.rule };
    case "invalid_response":
      return { status: 502, outcomeUnknown: true, rule: err.rule };
    case "disabled":
    case "not_configured":
    case "unavailable":
      return { status: 503, outcomeUnknown: false, rule: err.rule };
    default:
      return { status: 500, outcomeUnknown: true, rule: err.rule };
  }
}

export function openbotTools(openbot: OpenBotService): ToolDefinition[] {
  return [
    defineTool({
      name: "openbot_status",
      description:
        "Checks live GangNiagaBot reachability and capabilities on the configured OpenBot URL.",
      parameters: z.object({}),
      execute: async () => {
        const { reachable, probe } = await openbot.probe();
        return {
          enabled: Boolean(openbot.config?.openbotEnabled),
          url: openbot.url,
          agentId: openbot.agentId,
          reachable,
          probe,
        };
      },
    }),
    defineTool({
      name: "openbot_computer_navigate",
      description: "Dispatches a computer navigation task to GangNiagaBot via OpenBotAdapter.",
      parameters: z.object({
        botId: z.string().min(1).describe("The OpenBot computer / bot identifier"),
        url: z.string().url().describe("The URL to navigate the bot to"),
        toolCallId: z.string().optional().describe("Optional tool call tracking ID"),
      }),
      execute: async ({ botId, url, toolCallId }) => {
        const adapter = openbot.adapter();
        return await adapter.navigate(botId, { url, toolCallId });
      },
    }),
    defineTool({
      name: "openbot_computer_snapshot",
      description:
        "Captures an accessibility snapshot from a GangNiagaBot computer via OpenBotAdapter.",
      parameters: z.object({
        botId: z.string().min(1).describe("The OpenBot computer / bot identifier"),
      }),
      execute: async ({ botId }) => {
        const adapter = openbot.adapter();
        return await adapter.snapshot(botId);
      },
    }),
  ];
}
