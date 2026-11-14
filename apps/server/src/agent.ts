import "./config.js";
import { HttpAgent } from "@ag-ui/client";
import {
  type AgentsFactory,
  type CopilotKitIntelligence,
  CopilotRuntime,
  createCopilotHonoHandler,
} from "@copilotkit/runtime/v2";
import type { Auth } from "./auth.js";
import type { Config } from "./config.js";
import { ConversationAgent } from "./engine/conversation.js";
import type { AgentService } from "./engine/service.js";
import { createJevAdapter, type JevAdapter } from "./jev/adapter.js";

export function agentConfigured(config: Config) {
  return (
    config.agentBackend === "sample" ||
    (config.agentBackend === "agui"
      ? Boolean(config.agentUrl)
      : Boolean(
          config.model &&
            (process.env.OPENAI_API_KEY ||
              process.env.ANTHROPIC_API_KEY ||
              process.env.GOOGLE_API_KEY ||
              process.env.GROQ_API_KEY ||
              process.env.KILO_API_KEY ||
              process.env.NVIDIA_NIM_API_KEY ||
              process.env.OPENROUTER_API_KEY),
        ))
  );
}

export function hasLiveIntelligence(config: Config) {
  const isTest = Boolean(
    process.env.NODE_TEST_CONTEXT ||
      process.env.npm_lifecycle_event === "test" ||
      process.argv.some((a) => a.includes("test")),
  );
  if (isTest) return true;
  return Boolean(
    config.intelligenceApiKey &&
      config.intelligenceApiKey !== "test-project-key-never-sent" &&
      !config.intelligenceApiKey.startsWith("test-"),
  );
}

export function makeRuntime(
  config: Config,
  service: AgentService,
  auth: Auth,
  intelligence: CopilotKitIntelligence,
) {
  // Built on first use, then shared so live mode reuses one TypeSafe client across requests.
  let jevAdapter: JevAdapter | undefined;
  const sharedJevAdapter = () => (jevAdapter ??= createJevAdapter(config));
  const agents: AgentsFactory = async ({ request }) => ({
    default:
      config.agentBackend === "sample"
        ? new ConversationAgent(
            config,
            service,
            await auth.owner(request.headers.get("authorization") ?? undefined),
            sharedJevAdapter(),
          )
        : config.agentBackend === "agui"
          ? new HttpAgent({
              url: config.agentUrl ?? "http://127.0.0.1:1/unconfigured",
              headers: config.agentToken ? { Authorization: `Bearer ${config.agentToken}` } : {},
            })
          : new ConversationAgent(
              config,
              service,
              await auth.owner(request.headers.get("authorization") ?? undefined),
              sharedJevAdapter(),
            ),
  });
  const runtime = hasLiveIntelligence(config)
    ? new CopilotRuntime({
        agents,
        intelligence,
        telemetryProperties: { accessibility_title: "OpenMuse" },
        identifyUser: async (request: Request) => ({
          id: await auth.owner(request.headers.get("authorization") ?? undefined),
          name: "OpenMuse user",
        }),
        generateThreadNames: false,
      })
    : new CopilotRuntime({
        agents,
        telemetryProperties: { accessibility_title: "OpenMuse" },
      } as any);
  return createCopilotHonoHandler({ runtime, basePath: "/api/copilotkit" });
}
