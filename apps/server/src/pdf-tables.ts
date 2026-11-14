import { Worker } from "node:worker_threads";
import type { TableFormat } from "../../worker/src/extraction.js";
import { AppError } from "./errors.js";
export function extractPdfTables(
  bytes: Uint8Array,
  format: TableFormat = "json",
  signal?: AbortSignal,
): Promise<unknown> {
  if (
    !bytes.length ||
    bytes.length > 10 * 1024 * 1024 ||
    !["json", "csv", "markdown"].includes(format)
  )
    return Promise.reject(
      new AppError("Choose a PDF up to 10 MB and a supported table format", 422),
    );
  if (signal?.aborted) return Promise.reject(new AppError("PDF table extraction cancelled", 409));
  return new Promise((resolve, reject) => {
    const source = import.meta.url.endsWith(".ts");
    const worker = new Worker(
      new URL(source ? "./pdf-table-worker.ts" : "./pdf-table-worker.js", import.meta.url),
      {
        workerData: { bytes, format },
        execArgv: source ? ["--import", "tsx"] : [],
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      },
    );
    let settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(new AppError("PDF table extraction cancelled", 409));
    const timer = setTimeout(
      () => finish(new AppError("PDF table extraction timed out", 503)),
      15000,
    );
    worker.once("message", (message) =>
      message?.ok
        ? finish(undefined, message.result)
        : finish(new AppError("No supported text table could be extracted from this PDF", 422)),
    );
    worker.once("error", () => finish(new AppError("PDF table extraction is unavailable", 503)));
    worker.once("exit", () => {
      if (!settled) finish(new AppError("PDF table extraction stopped", 503));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
