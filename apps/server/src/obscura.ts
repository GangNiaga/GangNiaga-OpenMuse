import { spawn } from "node:child_process";
import { defineTool, type ToolDefinition } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { validatePublicUrl } from "../../worker/src/network.ts";
import { startEgressProxy } from "../../worker/src/proxy.ts";
import { AppError } from "./errors.ts";

export interface ObscuraFetchOptions {
  url: string;
  dump?: "markdown" | "text" | "html" | "links";
  stealth?: boolean;
  selector?: string;
  evalJs?: string;
  timeoutSec?: number;
  allowPrivateNetwork?: boolean;
  signal?: AbortSignal;
}
export interface ObscuraFetchResult {
  url: string;
  content: string;
  dump: string;
  stealth: boolean;
  truncated: boolean;
}
export function obscuraEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
  ];
  return {
    ...Object.fromEntries(
      allowed.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]])),
    ),
    OBSCURA_ALLOW_PRIVATE_NETWORK: "0",
  };
}
export async function isObscuraAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const bin =
      process.env.OBSCURA_BIN?.trim() || (process.platform === "win32" ? "obscura.exe" : "obscura");
    const child = spawn(bin, ["--version"], { stdio: "ignore", shell: false });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 3000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

const MAX_EVAL_JS_LEN = 4096;
const MAX_SELECTOR_LEN = 4096;

export async function obscuraFetch(options: ObscuraFetchOptions): Promise<ObscuraFetchResult> {
  const {
    url,
    dump = "markdown",
    stealth = true,
    selector,
    evalJs,
    timeoutSec = 30,
    allowPrivateNetwork = false,
    signal,
  } = options;

  signal?.throwIfAborted();
  if (allowPrivateNetwork) throw new AppError("Private network access is disabled", 403);
  await validatePublicUrl(url);
  // Length validation
  if (selector && selector.length > MAX_SELECTOR_LEN) {
    return Promise.reject(
      new AppError(`selector must be at most ${MAX_SELECTOR_LEN} characters`, 400),
    );
  }
  if (evalJs && evalJs.length > MAX_EVAL_JS_LEN) {
    return Promise.reject(
      new AppError(`evalJs must be at most ${MAX_EVAL_JS_LEN} characters`, 400),
    );
  }

  const proxy = await startEgressProxy();
  try {
    return await new Promise<ObscuraFetchResult>((resolve, reject) => {
      signal?.throwIfAborted();

      const isWin = process.platform === "win32";
      const bin = process.env.OBSCURA_BIN?.trim() || (isWin ? "obscura.exe" : "obscura");
      const args = [
        "fetch",
        url,
        "--dump",
        dump,
        "--timeout",
        String(timeoutSec),
        "--quiet",
        "--proxy",
        proxy.url,
      ];

      if (stealth) args.push("--stealth");
      if (allowPrivateNetwork) args.push("--allow-private-network");
      if (selector) args.push("--selector", selector);
      if (evalJs) args.push("--eval", evalJs);

      let stdout = "";
      let stderr = "";
      let settled = false;

      const useShell =
        isWin && (bin.toLowerCase().endsWith(".cmd") || bin.toLowerCase().endsWith(".bat"));
      if (useShell && args.some((arg) => /[&|<>^%!\r\n]/.test(arg)))
        throw new AppError("Shell wrappers cannot accept these arguments", 422);
      const child = spawn(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: useShell,
        env: obscuraEnvironment(),
      });

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };

      const onAbort = () => {
        if (!settled) {
          settled = true;
          cleanup();
          child.kill();
          reject(new AppError("Obscura fetch aborted", 500));
        }
      };

      const timer = setTimeout(
        () => {
          if (!settled) {
            settled = true;
            cleanup();
            child.kill();
            reject(new AppError("Obscura fetch timed out", 502));
          }
        },
        (Math.min(Math.max(timeoutSec, 1), 120) + 2) * 1000,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();

      child.stdout.on("data", (chunk: Buffer) => {
        // Bounded output cap (64 KB) for safe model context consumption
        if (stdout.length < 64 * 1024) {
          stdout += chunk.toString("utf8").slice(0, 64 * 1024 - stdout.length);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        // Bounded stderr cap (64 KB)
        if (stderr.length < 64 * 1024) {
          stderr += chunk.toString("utf8").slice(0, 64 * 1024 - stderr.length);
        }
      });

      child.on("error", () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new AppError("Obscura execution failed; check the configured binary", 502));
        }
      });

      child.on("close", (code) => {
        if (!settled) {
          settled = true;
          cleanup();
          if (code !== 0) {
            reject(new AppError(`Obscura fetch failed (exit code ${code})`, 502));
          } else {
            const truncated = stdout.length >= 64 * 1024;
            resolve({
              url,
              content: stdout.slice(0, 64 * 1024),
              dump,
              stealth,
              truncated,
            });
          }
        }
      });
    });
  } finally {
    await proxy.close();
  }
}

export const obscuraFetchSchema = z.object({
  url: z.string().url().max(4096).describe("The URL to fetch, scrape, or read"),
  dump: z
    .enum(["markdown", "text", "html", "links"])
    .default("markdown")
    .describe(
      "Extraction format: 'markdown' for clean readable structure, 'text' for raw text, 'html' for full DOM, or 'links' for URLs on the page",
    ),
  stealth: z
    .boolean()
    .default(true)
    .describe(
      "Enable anti-detection stealth mode (spoofs fingerprint, bypasses Cloudflare/bot mitigations)",
    ),
  selector: z
    .string()
    .max(4096, "selector must be at most 4096 characters")
    .optional()
    .describe("Optional CSS selector to extract only a specific element from the page"),
  evalJs: z
    .string()
    .max(4096, "evalJs must be at most 4096 characters")
    .optional()
    .describe("Optional JavaScript to execute in the page context"),
});

/** Obscura tools for CopilotKit runtime and TanStack agent loops. */
export function obscuraTools(options: { signal?: AbortSignal } = {}): ToolDefinition[] {
  return [
    defineTool({
      name: "obscura_fetch",
      description:
        "Fetch, execute JavaScript, and extract content from any public webpage using Obscura's high-speed Rust browser engine with native V8 execution and built-in anti-detection stealth. Returns clean rendered Markdown or text without the overhead of Chrome. Ideal for fast web scraping and bypassing bot detection.",
      parameters: obscuraFetchSchema,
      execute: async (args) => {
        try {
          return await obscuraFetch({ ...args, signal: options.signal });
        } catch (error) {
          return { error: error instanceof Error ? error.message : "Obscura fetch failed" };
        }
      },
    }),
  ];
}
