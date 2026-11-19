/** 构建脚本：esbuild 打包 MV3 各入口，复制静态资源。 */
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });
for (const dir of ['background', 'content', 'ui']) {
  await mkdir(join(dist, dir), { recursive: true });
}

const entries = [
  { in: 'src/background/index.ts', out: 'background/service-worker.js', format: 'esm' },
  { in: 'src/content/index.ts', out: 'content/content.js', format: 'iife' },
  { in: 'src/ui/popup.ts', out: 'ui/popup.js', format: 'esm' },
  { in: 'src/ui/options.ts', out: 'ui/options.js', format: 'esm' },
  { in: 'src/ui/offscreen.ts', out: 'ui/offscreen.js', format: 'esm' },
];

for (const entry of entries) {
  await build({
    entryPoints: [join(root, entry.in)],
    outfile: join(dist, entry.out),
    bundle: true,
    format: entry.format,
    platform: 'browser',
    target: 'chrome116',
    minify: false,
    sourcemap: false,
    logLevel: 'silent',
  });
}

await cp(join(root, 'manifest.json'), join(dist, 'manifest.json'));
for (const html of ['popup.html', 'options.html', 'offscreen.html']) {
  await cp(join(root, 'ui', html), join(dist, 'ui', html));
}
await cp(join(root, 'ui', 'shared.css'), join(dist, 'ui', 'shared.css'));
await cp(join(root, 'icons'), join(dist, 'icons'), { recursive: true });

console.log(`build ok: ${dist}`);
