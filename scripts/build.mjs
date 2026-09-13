/**
 * 唯一构建入口：生成前端、Node bundle、SEA 可执行文件和 tar/zip 分发包。
 *
 * 每个阶段仍保持独立函数，便于按职责阅读；但所有发布产物都由 npm run build
 * 按正确顺序一次完成，避免 dist/ 被前端构建清空或漏掉某个发布步骤。
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';
import { build as buildWeb } from 'vite';
import { build as buildServer } from 'esbuild';
import { getMimeType } from 'hono/utils/mime';

const DIST = 'dist';

const rootPackage = JSON.parse(readFileSync('package.json', 'utf-8'));
const APP_VERSION = JSON.stringify(rootPackage.version);

function collectAssets(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectAssets(full));
      continue;
    }
    if (entry.startsWith('quotahot') || entry === 'package.json') continue;
    out.push(full);
  }
  return out;
}

function assetsModule() {
  const entries = collectAssets(DIST).map((file) => {
    const url = '/' + relative(DIST, file).split(sep).join(posix.sep);
    const type = getMimeType(file) ?? 'application/octet-stream';
    return `[${JSON.stringify(url)},{type:${JSON.stringify(type)},body:D(${JSON.stringify(
      readFileSync(file).toString('base64'),
    )})}]`;
  });
  console.log(`内嵌前端资源 ${entries.length} 个`);
  const decode =
    "const D=(s)=>{const b=Buffer.from(s,'base64');return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)};";
  return `${decode}\nexport const EMBEDDED_ASSETS=new Map([${entries.join(',')}]);\n`;
}

const inlineAssets = {
  name: 'inline-assets',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\/assets\.js$/ }, () => ({ path: 'assets', namespace: 'embedded' }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'embedded' }, () => ({
      contents: assetsModule(),
      loader: 'js',
    }));
  },
};

async function buildServerBundle() {
  const bin = join(DIST, 'quotahot');
  const result = await buildServer({
    entryPoints: ['src/main.ts'],
    outfile: bin,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    plugins: [inlineAssets],
    logLevel: 'info',
    banner: { js: '#!/usr/bin/env node' },
    define: { 'import.meta.dirname': '__dirname', __QUOTAHOT_VERSION__: APP_VERSION },
    metafile: true,
  });
  chmodSync(bin, 0o755);
  writeFileSync(join(DIST, 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n');
  writeFileSync(join(DIST, 'quotahot.meta.json'), `${JSON.stringify(result.metafile, null, 2)}\n`);
  console.log(`\n  ${bin}  可直接放进 PATH 上的 bin 目录`);
}

function buildSea() {
  const out = join('release', process.platform === 'win32' ? 'quotahot.exe' : 'quotahot');
  if (!existsSync('dist/quotahot')) {
    throw new Error('缺少 dist/quotahot，无法生成 SEA');
  }
  mkdirSync('release', { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'quotahot-sea-'));
  const configPath = join(work, 'sea-config.json');
  const blob = join(work, 'sea-prep.blob');
  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        main: 'dist/quotahot',
        output: blob,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
      }),
    );
    console.log('生成 SEA blob…');
    execFileSync(process.execPath, ['--experimental-sea-config', configPath], { stdio: 'inherit' });
    copyFileSync(process.execPath, out);
    chmodSync(out, 0o755);
    if (process.platform === 'darwin') {
      execFileSync('codesign', ['--remove-signature', out], { stdio: 'inherit' });
    }
    console.log('注入到可执行文件…');
    execFileSync(
      'npx',
      [
        '--yes',
        'postject',
        out,
        'NODE_SEA_BLOB',
        blob,
        '--sentinel-fuse',
        'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
        ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
      ],
      { stdio: 'inherit' },
    );
    if (process.platform === 'darwin') {
      execFileSync('codesign', ['--sign', '-', out], { stdio: 'inherit' });
    }
    console.log(`已生成 ${out}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function packageArchive() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
  const name = `quotahot-${pkg.version}`;
  if (!existsSync('dist/quotahot')) {
    throw new Error('dist/ 里缺少构建产物，无法生成分发包');
  }
  const stage = join('release', name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  copyFileSync('dist/quotahot', join(stage, 'quotahot'));
  chmodSync(join(stage, 'quotahot'), 0o755);
  copyFileSync('scripts/install.sh', join(stage, 'install.sh'));
  chmodSync(join(stage, 'install.sh'), 0o755);
  writeFileSync(join(stage, 'start.cmd'), `@echo off\r\nnode "%~dp0quotahot"\r\n`);
  writeFileSync(
    join(stage, 'README.txt'),
    [
      'QuotaHot',
      '',
      '前置：Node.js 24 或更高（用到内置 node:sqlite；Node 22.5–23.x 需加 --experimental-sqlite）。',
      '',
      '安装并启动 Linux systemd 用户服务：',
      '  ./install.sh                 # 默认端口 8686',
      '  ./install.sh --port 9000     # 指定端口',
      '',
      '直接运行：',
      '  Linux / macOS   ./quotahot',
      '  Windows         start.cmd',
      '',
      '装成一条命令（Linux / macOS）：',
      '  sudo cp quotahot /usr/local/bin/     # 或者 cp 到 ~/.local/bin/',
      '  quotahot',
      '',
      '界面和后端都在这一个文件里，从哪个目录启动都行。',
      '默认监听 8686，用环境变量 PORT 改端口。',
      '配置、状态库和账户放在 ~/.quotahot/，用环境变量 QUOTAHOT_DATA_DIR 可以改到别处。',
      'Linux 安装脚本写入 ~/.quotahot/bin/quotahot，使用 quotahot.service 服务名。',
      '不需要 sudo；直接覆盖，不留备份。',
      '',
      'Windows 上的两处限制：Claude 保活需要本机 claude CLI，Node 无法直接拉起 .cmd 包装脚本；',
      'Qoder 凭证由 DPAPI 加密，暂不支持导入。两者在 WSL2 里按 Linux 方式运行不受影响。',
    ].join('\n'),
  );

  const tarball = `${name}.tar.gz`;
  const zip = `${name}.zip`;
  try {
    execFileSync('tar', ['-czf', tarball, name], { cwd: 'release', stdio: 'inherit' });
    let zipped = false;
    for (const [cmd, args] of [
      ['zip', ['-qr', zip, name]],
      ['bsdtar', ['-a', '-cf', zip, name]],
      ['tar', ['-a', '-cf', zip, name]],
    ]) {
      try {
        execFileSync(cmd, args, { cwd: 'release', stdio: 'ignore' });
        zipped = true;
        break;
      } catch {
        rmSync(join('release', zip), { force: true });
      }
    }
    console.log(
      `已生成 release/${tarball}${zipped ? ` 和 release/${zip}` : '（本机没有可用的 zip 工具，未生成 .zip）'}`,
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

await buildWeb();
await buildServerBundle();
buildSea();
packageArchive();
