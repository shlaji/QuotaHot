import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const IMPORT_PATTERN = /(?:from\s+|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set(['dist', 'node_modules']);

async function typescriptFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) return typescriptFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
}

function sourcePath(importer: string, specifier: string): string {
  const resolved = resolve(dirname(importer), specifier);
  return resolved.endsWith('.js') ? `${resolved.slice(0, -3)}.ts` : resolved;
}

test('hook package imports only hook-owned code', async () => {
  // Given: every TypeScript source reachable from the standalone hook directory.
  const files = await typescriptFiles(PACKAGE_ROOT);

  // When: relative imports are resolved to repository source paths.
  const outsideImports: string[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const imported = sourcePath(file, specifier);
      if (!imported.startsWith(`${PACKAGE_ROOT}/`)) {
        outsideImports.push(`${relative(PACKAGE_ROOT, file)} -> ${relative(PACKAGE_ROOT, imported)}`);
      }
    }
  }

  // Then: the hook has a real entrypoint and no dependency on existing business modules.
  assert.ok(files.includes(resolve(PACKAGE_ROOT, 'src/runtime.ts')), 'src/runtime.ts must exist');
  assert.deepEqual(outsideImports, []);
});

test('hook owns an independent package entrypoint and build', async () => {
  // Given: the hook is intended to build after being copied without the main program.
  const required = ['package.json', 'tsconfig.json', 'scripts/build.mjs', 'src/index.ts', 'README.md'];

  // When/Then: every package boundary file exists under hooks itself.
  await Promise.all(required.map((path) => access(resolve(PACKAGE_ROOT, path))));
});

test('package source scan excludes installed and generated directories', async (context) => {
  // Given: package source beside dependency and build-output TypeScript files.
  const root = await mkdtemp(join(tmpdir(), 'quotahot-hook-scan-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(resolve(root, 'source'), { recursive: true }),
    mkdir(resolve(root, 'node_modules', 'dependency'), { recursive: true }),
    mkdir(resolve(root, 'dist', 'generated'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(resolve(root, 'source', 'owned.ts'), ''),
    writeFile(resolve(root, 'node_modules', 'dependency', 'external.ts'), ''),
    writeFile(resolve(root, 'dist', 'generated', 'bundle.ts'), ''),
  ]);
  // When: package-owned TypeScript files are enumerated.
  const files = await typescriptFiles(root);
  // Then: only source-controlled package paths are returned.
  assert.deepEqual(files.map((file) => relative(root, file)), ['source/owned.ts']);
});
