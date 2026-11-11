import assert from "node:assert/strict";
import { test } from "node:test";
import { isObscuraAvailable, obscuraFetch, obscuraTools } from "../apps/server/src/obscura.ts";

test("isObscuraAvailable detects globally installed Obscura binary", async () => {
  const available = await isObscuraAvailable();
  assert.equal(available, true);
});

test("obscuraTools exposes obscura_fetch tool with valid parameters", () => {
  const tools = obscuraTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "obscura_fetch");
  assert.match(tools[0].description, /Obscura/i);
});

test("obscuraFetch renders and extracts markdown from public webpage", async () => {
  const result = await obscuraFetch({
    url: "https://example.com",
    dump: "markdown",
    stealth: true,
  });

  assert.equal(result.url, "https://example.com");
  assert.equal(result.dump, "markdown");
  assert.equal(result.stealth, true);
  assert.equal(result.truncated, false);
  assert.match(result.content, /documentation examples/i);
});
