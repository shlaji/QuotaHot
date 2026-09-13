import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
const rootPackage = JSON.parse(await readFile('../package.json', 'utf8'));
const hookPackage = JSON.parse(await readFile('package.json', 'utf8'));
if (rootPackage.version !== hookPackage.version) {
  throw new Error(`Version mismatch: QuotaHot ${rootPackage.version} != QuotaHot Hook ${hookPackage.version}`);
}
const result = await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/quotahot-hook',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  banner: { js: '#!/usr/bin/env node' },
  metafile: true,
  logLevel: 'info',
    define: { __QUOTAHOT_VERSION__: JSON.stringify(hookPackage.version) },
});
await chmod('dist/quotahot-hook', 0o755);
await writeFile('dist/package.json', '{"type":"commonjs"}\n');
await writeFile('dist/meta.json', `${JSON.stringify(result.metafile, null, 2)}\n`);

const { version } = hookPackage;
const name = `quotahot-hook-${version}`;
const stage = `release/${name}`;
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
try {
  for (const [source, destination] of [
    ['dist/quotahot-hook', 'quotahot-hook'],
    ['dist/package.json', 'package.json'],
    ['scripts/install.sh', 'install.sh'],
    ['README.md', 'README.md'],
  ]) {
    await copyFile(source, `${stage}/${destination}`);
  }
  await chmod(`${stage}/quotahot-hook`, 0o755);
  await chmod(`${stage}/install.sh`, 0o755);
  execFileSync('tar', ['-czf', `release/${name}.tar.gz`, '-C', 'release',
    `${name}/quotahot-hook`, `${name}/package.json`, `${name}/install.sh`, `${name}/README.md`]);
  console.log(`Install package: release/${name}.tar.gz`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
