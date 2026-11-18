/** G4：安全静态扫描（S-1/S-2/S-3/M-2/M-4/S-4）。 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const violations = [];

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

const files = await walk(join(root, 'src'));
const SENSITIVE_KEYS = [
  'masterPassword',
  'password:',
  'symmetricKey',
  'accessToken',
  'refreshToken',
  'totp',
];

for (const file of files) {
  const rel = relative(root, file);
  const code = stripComments(await readFile(file, 'utf8'));

  if (/\blocalStorage\b|\bsessionStorage\b/.test(code)) {
    violations.push(`${rel}: S-1 禁止 localStorage / sessionStorage`);
  }
  if (/storage\.local\.set\s*\(\s*\{[\s\S]*?\}\s*\)/.test(code)) {
    const blocks = code.match(/storage\.local\.set\s*\(\s*\{[\s\S]*?\}\s*\)/g) ?? [];
    for (const block of blocks) {
      if (SENSITIVE_KEYS.some((key) => block.includes(key))) {
        violations.push(`${rel}: S-1 storage.local 不得写入敏感字段`);
      }
    }
  }
  if (/console\.(log|debug|info|warn|error)\s*\(/.test(code)) {
    if (rel === 'src/shared/logger.ts') {
      // 唯一允许的封装点，字段已白名单脱敏
    } else {
      violations.push(`${rel}: S-2 禁止直接使用 console，请走 shared/logger`);
    }
  }
  if (/\beval\s*\(|new\s+Function\s*\(/.test(code)) {
    violations.push(`${rel}: M-4 禁止 eval / new Function`);
  }
  if (/\binnerHTML\s*=/.test(code)) {
    violations.push(`${rel}: S-4 禁止 innerHTML 写入`);
  }
  const insecureUrls = [...code.matchAll(/["'`](http:\/\/[^"'`]+)["'`]/g)]
    .map((match) => match[1])
    .filter((url) => !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url));
  if (insecureUrls.length > 0) {
    violations.push(`${rel}: S-3 禁止非回环 HTTP 地址`);
  }
}

const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
if (Array.isArray(manifest.host_permissions) && manifest.host_permissions.length > 0) {
  violations.push('manifest.json: M-2/M-3 禁止写死 host_permissions');
}

const report = {
  gate: 'G4',
  scannedFiles: files.length,
  violations,
};
console.log(JSON.stringify(report, null, 2));
process.exit(violations.length === 0 ? 0 : 1);
