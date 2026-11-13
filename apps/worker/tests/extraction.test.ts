import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowserManager } from "../src/browser.ts";
import { createBrowserFixture, fixtureOrigin } from "./fixtures.ts";

test("real browser extracts tables and clips screenshots without changing viewport", {
  timeout: 60000,
}, async () => {
  const fixture = await createBrowserFixture();
  const directory = await mkdtemp(join(tmpdir(), "openmuse-tables-"));
  let browser: Awaited<ReturnType<typeof createBrowserManager>> | undefined;
  try {
    browser = await createBrowserManager({ dataDir: directory }, fixture.createProxy);
    const id = randomUUID();
    await browser.create(id, `${fixtureOrigin}/tables`);
    const result = (await browser.tables(id)) as { tables: { rows?: Record<string, string>[] }[] };
    assert.deepEqual(result.tables[0].rows, [{ Item: "Coffee", Price: "5.00" }]);
    const spans = (await browser.tables(id, "#spans")) as {
      tables: { rows: Record<string, string>[] }[];
    };
    assert.deepEqual(spans.tables[0].rows, [
      { Group: "Drinks", Item: "Coffee" },
      { Group: "Drinks", Item: "Tea" },
    ]);
    const png = await browser.screenshot(id, { x: 0, y: 0, width: 128, height: 64 });
    assert.equal(png.readUInt32BE(16), 128);
    assert.equal(png.readUInt32BE(20), 64);
    await assert.rejects(browser.screenshot(id, { x: 0, y: 0, width: 2000, height: 64 }));
  } finally {
    await browser?.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});
