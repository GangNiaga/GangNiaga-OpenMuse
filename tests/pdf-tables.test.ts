import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractPdfTables } from "../apps/server/src/pdf-tables.ts";

test("extracts an aligned text PDF in an isolated bounded worker", async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage();
  for (const [text, x, y] of [
    ["Item", 30, 700],
    ["Price", 230, 700],
    ["Coffee", 30, 670],
    ["5.00", 230, 670],
  ] as const)
    page.drawText(text, { x, y, font, size: 12 });
  const result = (await extractPdfTables(await pdf.save())) as {
    tables: { rows: Record<string, string>[] }[];
  };
  assert.equal(result.tables[0].rows[0].Item, "Coffee");
  assert.equal(result.tables[0].rows[0].Price, "5.00");
});
test("invalid PDFs fail and aborted extraction cannot continue", async () => {
  await assert.rejects(extractPdfTables(new Uint8Array([1, 2, 3])));
  await assert.rejects(
    extractPdfTables(new Uint8Array([1]), "json", AbortSignal.abort()),
    /cancelled/,
  );
});
