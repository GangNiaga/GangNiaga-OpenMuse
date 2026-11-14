import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const entrypoints = ["api/_handler.ts", "api/[...route].ts", "api/index.ts"];

function serverlessImportGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const queue = [...entrypoints];
  const visited = new Set<string>();

  while (queue.length) {
    const file = normalize(queue.pop() ?? "");
    if (visited.has(file)) continue;
    visited.add(file);

    const source = readFileSync(join(repositoryRoot, file), "utf8").replace(
      /import\s+type\s+[^;]+?\sfrom\s+["'][^"']+["'];?/g,
      "",
    );
    const specifiers: string[] = [];
    for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])(\.[^"']+)\1/g)) {
      const specifier = match[2];
      if (!specifier.startsWith(".")) continue;
      specifiers.push(specifier);
      const target = normalize(join(dirname(file), specifier));
      const source = target.endsWith(".js") ? `${target.slice(0, -3)}.ts` : target;
      if (!visited.has(source)) queue.push(source);
    }
    graph.set(file, specifiers);
  }

  return graph;
}

test("serverless entry graph uses runtime-resolvable relative JavaScript specifiers", () => {
  const buildConfig = JSON.parse(
    readFileSync(join(repositoryRoot, "tsconfig.build.json"), "utf8"),
  ) as { compilerOptions?: { rewriteRelativeImportExtensions?: boolean } };
  const workerSourcesAreRewritten =
    buildConfig.compilerOptions?.rewriteRelativeImportExtensions === true;
  const invalid = [...serverlessImportGraph()]
    .flatMap(([file, specifiers]) =>
      specifiers
        .filter(
          (specifier) =>
            specifier.endsWith(".ts") &&
            !(workerSourcesAreRewritten && file.includes(join("apps", "worker", "src"))),
        )
        .map(
          (specifier) => `${relative(repositoryRoot, join(repositoryRoot, file))}: ${specifier}`,
        ),
    )
    .sort();

  assert.deepEqual(invalid, []);
});

test("Vercel deployment excludes local workspace data and environment files", () => {
  const vercelIgnore = readFileSync(join(repositoryRoot, ".vercelignore"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  assert.ok(vercelIgnore.includes(".openmuse"));
  assert.ok(vercelIgnore.includes(".openmuse/**"));
  assert.ok(vercelIgnore.includes(".env"));
  assert.ok(vercelIgnore.includes(".env.*"));
});
