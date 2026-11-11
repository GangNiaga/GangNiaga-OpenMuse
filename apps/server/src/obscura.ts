import { spawn } from "node:child_process";
import { defineTool, type ToolDefinition } from "@copilotkit/runtime/v2";
import { z } from "zod";
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

/** Checks whether the global Obscura executable is available on the host system PATH. */
export async function isObscuraAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const bin = process.env.OBSCURA_BIN?.trim() || (isWin ? "obscura.exe" : "obscura");
    const useShell =
      isWin && (bin.toLowerCase().endsWith(".cmd") || bin.toLowerCase().endsWith(".bat"));
    const proc = spawn(bin, ["--version"], { stdio: "ignore", shell: useShell });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/** Executes Obscura in high-speed, headless V8 mode to scrape, render or extract clean content from a URL. */
export function obscuraFetch(options: ObscuraFetchOptions): Promise<ObscuraFetchResult> {
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

  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();

    const isWin = process.platform === "win32";
    const bin = process.env.OBSCURA_BIN?.trim() || (isWin ? "obscura.exe" : "obscura");
    const args = ["fetch", url, "--dump", dump, "--timeout", String(timeoutSec), "--quiet"];

    if (stealth) args.push("--stealth");
    if (allowPrivateNetwork) args.push("--allow-private-network");
    if (selector) args.push("--selector", selector);
    if (evalJs) args.push("--eval", evalJs);

    let stdout = "";
    let stderr = "";
    let settled = false;

    const useShell =
      isWin && (bin.toLowerCase().endsWith(".cmd") || bin.toLowerCase().endsWith(".bat"));
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: useShell,
    });

    const cleanup = () => {
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

    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      // Bounded output cap (64 KB) for safe model context consumption
      if (stdout.length < 64 * 1024) {
        stdout += chunk.toString("utf8");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new AppError(`Obscura execution failed: ${err.message}`, 502));
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        cleanup();
        if (code !== 0) {
          reject(
            new AppError(
              `Obscura failed to fetch ${url} (exit code ${code}): ${stderr.trim() || "Unknown error"}`,
              502,
            ),
          );
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
    .optional()
    .describe("Optional CSS selector to extract only a specific element from the page"),
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
