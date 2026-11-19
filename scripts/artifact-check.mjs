/** G6：构建产物断言（manifest、无远程代码、体积阈值）。 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const violations = [];
const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));

if (manifest.manifest_version !== 3) violations.push('manifest_version 必须为 3');
const allowedPermissions = new Set([
  'activeTab',
  'storage',
  'scripting',
  'nativeMessaging',
  'contextMenus',
  'clipboardWrite',
  'notifications',
  'offscreen',
]);
for (const permission of manifest.permissions ?? []) {
  if (!allowedPermissions.has(permission)) {
    violations.push(`权限 ${permission} 不在白名单`);
  }
}
if (Array.isArray(manifest.host_permissions) && manifest.host_permissions.length > 0) {
  violations.push('禁止静态 host_permissions');
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

const files = await walk(dist);
let totalBytes = 0;
for (const file of files) {
  const size = (await stat(file)).size;
  totalBytes += size;
  if (!file.endsWith('.js')) continue;
  const code = await readFile(file, 'utf8');
  if (/\beval\s*\(|new\s+Function\s*\(/.test(code)) {
    violations.push(`${relative(dist, file)}: 含远程代码执行模式`);
  }
  if (/sourceMappingURL\s*=\s*https?:/.test(code)) {
    violations.push(`${relative(dist, file)}: 引用远程 source map`);
  }
}

const required = [
  'manifest.json',
  `background${sep}service-worker.js`,
  `content${sep}content.js`,
  `ui${sep}popup.html`,
  `ui${sep}popup.js`,
  `ui${sep}options.html`,
  `ui${sep}options.js`,
  `ui${sep}offscreen.html`,
  `ui${sep}offscreen.js`,
  `ui${sep}shared.css`,
  `icons${sep}icon-16.png`,
  `icons${sep}icon-32.png`,
  `icons${sep}icon-48.png`,
  `icons${sep}icon-128.png`,
];
for (const [size, path] of Object.entries(manifest.icons ?? {})) {
  if (!(await stat(join(dist, path)).catch(() => null))) {
    violations.push(`manifest.icons.${size} 指向的文件不存在: ${path}`);
  }
}
if (!manifest.action?.default_icon) violations.push('缺少 action.default_icon');
for (const item of required) {
  if (!(await stat(join(dist, item)).catch(() => null))) {
    violations.push(`缺少产物 ${item}`);
  }
}

const MAX_BYTES = 2 * 1024 * 1024;
if (totalBytes > MAX_BYTES) violations.push('产物总体积超过 2MB');

console.log(JSON.stringify({ gate: 'G6', files: files.length, totalBytes, violations }, null, 2));
process.exit(violations.length === 0 ? 0 : 1);
