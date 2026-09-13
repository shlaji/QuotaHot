import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE_ROOT = resolve(ROOT, 'src');
const HOOKS_ROOT = resolve(ROOT, 'hooks');
const IMPORT_PATTERN = /(?:from\s+|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

async function typescriptFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
}

function sourcePath(importer: string, specifier: string): string {
  const resolved = resolve(dirname(importer), specifier);
  return resolved.endsWith('.js') ? `${resolved.slice(0, -3)}.ts` : resolved;
}

test('main runtime imports no hook-owned code', async () => {
  // Given: every TypeScript source owned by the main program.
  const files = await typescriptFiles(SOURCE_ROOT);
  // When: relative imports are resolved to repository source paths.
  const hookImports: string[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const imported = sourcePath(file, specifier);
      if (imported.startsWith(`${HOOKS_ROOT}/`)) {
        hookImports.push(`${relative(ROOT, file)} -> ${relative(ROOT, imported)}`);
      }
    }
  }
  // Then: the main source tree is independent of the hook source tree.
  assert.deepEqual(hookImports, []);
});

test('main package and build contain no hook source inputs', async () => {
  // Given: the main manifest, compiler project, and build entrypoint.
  const [manifest, config, build] = await Promise.all([
    readFile(resolve(ROOT, 'package.json'), 'utf8'),
    readFile(resolve(ROOT, 'tsconfig.json'), 'utf8'),
    readFile(resolve(ROOT, 'scripts/build.mjs'), 'utf8'),
  ]);
  // When/Then: none of the main build definitions references hook source.
  assert.doesNotMatch(`${manifest}\n${config}\n${build}`, /hooks\//);
  assert.match(build, /entryPoints: \['src\/main\.ts'\]/);
});
