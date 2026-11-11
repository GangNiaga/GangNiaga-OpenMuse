import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isObscuraAvailable, obscuraFetch, obscuraTools } from "../apps/server/src/obscura.ts";

test("isObscuraAvailable detects binary presence and respects OBSCURA_BIN", async () => {
  const prev = process.env.OBSCURA_BIN;
  try {
    process.env.OBSCURA_BIN = process.execPath;
    assert.equal(await isObscuraAvailable(), true);

    process.env.OBSCURA_BIN = "nonexistent-obscura-binary-xyz";
    assert.equal(await isObscuraAvailable(), false);
  } finally {
    if (prev === undefined) delete process.env.OBSCURA_BIN;
    else process.env.OBSCURA_BIN = prev;
  }
});

test("obscuraTools exposes obscura_fetch tool with valid parameters", () => {
  const tools = obscuraTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "obscura_fetch");
  assert.match(tools[0].description, /Obscura/i);
});

test("obscuraFetch renders and extracts markdown or reports missing binary cleanly", async () => {
  const nativeAvailable = await isObscuraAvailable();
  if (nativeAvailable) {
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
    return;
  }

  const prev = process.env.OBSCURA_BIN;
  const dir = await mkdtemp(join(tmpdir(), "obscura-test-"));
  try {
    const wrapper = join(dir, process.platform === "win32" ? "mock-obscura.cmd" : "mock-obscura");
    const content =
      process.platform === "win32"
        ? `@echo off\r\necho # Example Domain\r\necho This domain is for use in documentation examples without needing permission.\r\n`
        : `#!/bin/sh\necho "# Example Domain"\necho "This domain is for use in documentation examples without needing permission."\n`;
    await writeFile(wrapper, content, { mode: 0o755 });
    process.env.OBSCURA_BIN = wrapper;

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
  } finally {
    if (prev === undefined) delete process.env.OBSCURA_BIN;
    else process.env.OBSCURA_BIN = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
