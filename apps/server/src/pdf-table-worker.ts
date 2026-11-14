import { parentPort, workerData } from "node:worker_threads";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { type TableFormat, tableResult } from "../../worker/src/extraction.js";

async function extract() {
  const task = getDocument({
    data: new Uint8Array(workerData.bytes),
    disableFontFace: true,
    useSystemFonts: true,
    verbosity: 0,
  });
  task.onPassword = () => {
    void task.destroy();
  };
  try {
    const document = await task.promise;
    if (document.numPages > 20) throw new Error("PDF table extraction is limited to 20 pages");
    const tables = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const { items } = await page.getTextContent();
      const cells = items.filter(
        (item): item is Extract<typeof item, { str: string }> =>
          "str" in item && Boolean(item.str.trim()),
      );
      const lines = new Map<number, { x: number; text: string }[]>();
      for (const cell of cells) {
        const y = Math.round(cell.transform[5] / 3) * 3;
        const line = lines.get(y) ?? [];
        line.push({ x: cell.transform[4], text: cell.str });
        lines.set(y, line);
      }
      const rows = [...lines]
        .sort(([a], [b]) => b - a)
        .map(([, line]) => line.sort((a, b) => a.x - b.x));
      const headerIndex = rows.findIndex((row) => row.length >= 2);
      if (headerIndex < 0) continue;
      const header = rows[headerIndex];
      if (header.length > 100) throw new Error("PDF table exceeds 100 columns");
      const matrix = [header.map((cell) => cell.text)];
      for (const row of rows.slice(headerIndex + 1)) {
        if (row.length < 2) continue;
        const values = header.map(() => "");
        for (const cell of row) {
          let index = 0;
          for (let i = 1; i < header.length; i++)
            if (Math.abs(header[i].x - cell.x) < Math.abs(header[index].x - cell.x)) index = i;
          values[index] += (values[index] ? " " : "") + cell.text;
        }
        matrix.push(values);
      }
      if (matrix.length > 1)
        tables.push({ page: pageNumber, ...tableResult(matrix, workerData.format as TableFormat) });
    }
    if (!tables.length) throw new Error("No aligned text table detected; scanned PDFs require OCR");
    const result = {
      tables,
      warnings: [
        "Tables are inferred from aligned PDF text. Verify merged cells, wrapping, and column boundaries against the original.",
      ],
    };
    if (JSON.stringify(result).length > 500000)
      throw new Error("Extracted PDF tables exceed 500 KB");
    parentPort?.postMessage({ ok: true, result });
  } finally {
    await task.destroy();
  }
}
extract().catch(() =>
  parentPort?.postMessage({
    ok: false,
    error: "PDF table extraction failed. Use a text PDF of at most 20 pages with an aligned table.",
  }),
);
