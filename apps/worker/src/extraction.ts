import { WorkerError } from "./errors.ts";
export type TableFormat = "json" | "csv" | "markdown";
export function tableResult(matrix: string[][], format: TableFormat = "json") {
  if (matrix.length > 1001 || matrix.some((row) => row.length > 100))
    throw new WorkerError(
      "TABLE_TOO_LARGE",
      "Tables are limited to 1000 data rows and 100 columns.",
      413,
    );
  const used = new Set<string>();
  const columns = (matrix[0] ?? []).map((cell, index) => {
    const base = cell.trim() || `column_${index + 1}`;
    let name = base,
      n = 2;
    while (used.has(name)) name = `${base}_${n++}`;
    used.add(name);
    return name;
  });
  const values = matrix.slice(1).map((row) => columns.map((_, index) => row[index] ?? ""));
  const rows = values.map((row) =>
    Object.fromEntries(columns.map((column, index) => [column, row[index]])),
  );
  if (format === "json") return { columns, rows };
  if (format === "csv") {
    const cell = (text: string) =>
      '"' + (/^[=+@\-\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""') + '"';
    return {
      columns,
      content: [columns, ...values].map((row) => row.map(cell).join(",")).join("\r\n"),
    };
  }
  const cell = (text: string) =>
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("|", "\\|")
      .replace(/\r?\n/g, " ");
  return {
    columns,
    content: [columns, columns.map(() => "---"), ...values]
      .map((row) => "| " + row.map(cell).join(" | ") + " |")
      .join("\n"),
  };
}
export function screenshotClip(
  value: unknown,
): { x: number; y: number; width: number; height: number } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object")
    throw new WorkerError("INVALID_CLIP", "A screenshot clip object is required.");
  const v = value as Record<string, unknown>;
  if (
    !["x", "y", "width", "height"].every(
      (key) => typeof v[key] === "number" && Number.isFinite(v[key]),
    ) ||
    (v.x as number) < 0 ||
    (v.y as number) < 0 ||
    (v.width as number) <= 0 ||
    (v.height as number) <= 0 ||
    (v.x as number) + (v.width as number) > 1280 ||
    (v.y as number) + (v.height as number) > 800
  )
    throw new WorkerError("INVALID_CLIP", "Clip must fit within the 1280 by 800 browser viewport.");
  return {
    x: v.x as number,
    y: v.y as number,
    width: v.width as number,
    height: v.height as number,
  };
}
