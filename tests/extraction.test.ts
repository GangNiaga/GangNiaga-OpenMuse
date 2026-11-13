import assert from "node:assert/strict";
import test from "node:test";
import { tableResult, screenshotClip } from "../apps/worker/src/extraction.ts";
test("table exports keep unique headers, empty cells, and safe CSV formula cells", () => {
  const matrix = [
    ["Name", "Name", ""],
    ["A", "=cmd()", "<b>|line\nnext"],
  ];
  const json = tableResult(matrix);
  assert.deepEqual(json.columns, ["Name", "Name_2", "column_3"]);
  assert.match(tableResult(matrix, "csv").content ?? "", /'=cmd/);
  assert.match(tableResult(matrix, "markdown").content ?? "", /&lt;b&gt;\\\|line next/);
  assert.throws(() => tableResult(Array.from({ length: 1002 }, () => [])));
});
test("screenshot clips reject out-of-bounds, NaN, and zero-size regions", () => {
  assert.deepEqual(screenshotClip({ x: 10, y: 10, width: 100, height: 100 }), {
    x: 10,
    y: 10,
    width: 100,
    height: 100,
  });
  for (const clip of [
    { x: -1, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: 0, height: 10 },
    { x: 0, y: 0, width: 1281, height: 800 },
    { x: NaN, y: 0, width: 10, height: 10 },
  ])
    assert.throws(() => screenshotClip(clip));
});
