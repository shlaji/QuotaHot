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
  define: { __QUOTAHOT_VERSION__: JSON.stringify(hookPackage.version), 'import.meta.dirname': '__dirname' },
});
await chmod('dist/quotahot-hook', 0o755);
await copyFile('src/opencode-plugin-template.js', 'dist/opencode-plugin-template.js');
await copyFile('src/opencode-notification-plugin-template.js', 'dist/opencode-notification-plugin-template.js');
const omoTemplate = await readFile('src/omo-plugin-template.js', 'utf8');
const recoveryMarker = '// __QUOTAHOT_OMO_RECOVERY__';
if (omoTemplate.split(recoveryMarker).length !== 2) throw new Error('OmO plugin template must contain exactly one recovery marker');
const statusMarker = '// __QUOTAHOT_OMO_RECOVERY_STATUS__';
if (omoTemplate.split(statusMarker).length !== 2) throw new Error('OmO plugin template must contain exactly one status marker');
await writeFile('dist/omo-plugin-template.js', omoTemplate
  .replace(recoveryMarker, await readFile('src/omo-recovery-template.js', 'utf8'))
  .replace(statusMarker, await readFile('src/omo-recovery-status-template.js', 'utf8')));
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
    ['dist/opencode-plugin-template.js', 'opencode-plugin-template.js'],
    ['dist/opencode-notification-plugin-template.js', 'opencode-notification-plugin-template.js'],
    ['dist/omo-plugin-template.js', 'omo-plugin-template.js'],
    ['dist/package.json', 'package.json'],
    ['scripts/install.sh', 'install.sh'],
    ['README.md', 'README.md'],
  ]) {
    await copyFile(source, `${stage}/${destination}`);
  }
  await chmod(`${stage}/quotahot-hook`, 0o755);
  await chmod(`${stage}/install.sh`, 0o755);
  execFileSync('tar', ['-czf', `release/${name}.tar.gz`, '-C', 'release',
    `${name}/quotahot-hook`, `${name}/opencode-plugin-template.js`, `${name}/opencode-notification-plugin-template.js`, `${name}/omo-plugin-template.js`, `${name}/package.json`, `${name}/install.sh`, `${name}/README.md`]);
  console.log(`Install package: release/${name}.tar.gz`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
