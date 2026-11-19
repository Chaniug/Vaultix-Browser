/** G5：依赖许可证检查（L-1）。 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const allowed = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'GPL-2.0+',
  'GPL-3.0',
  'GPL-3.0-only',
]);
const direct = {
  ...pkg.dependencies,
  ...pkg.devDependencies,
};
const violations = [];
const inspected = [];

for (const [name, version] of Object.entries(direct)) {
  let meta;
  try {
    meta = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'));
  } catch {
    violations.push(`${name}: 无法读取依赖元数据`);
    continue;
  }
  const license = meta.license?.type ?? meta.license ?? 'UNKNOWN';
  inspected.push({ name, version, license });
  if (!allowed.has(license)) {
    violations.push(`${name}@${version}: 许可证 ${license} 不在白名单`);
  }
}

try {
  await readFile(join(root, 'LICENSE'), 'utf8');
} catch {
  violations.push('LICENSE 文件缺失（L-4）');
}

console.log(JSON.stringify({ gate: 'G5', inspected, violations }, null, 2));
process.exit(violations.length === 0 ? 0 : 1);
