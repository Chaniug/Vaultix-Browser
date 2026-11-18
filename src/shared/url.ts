/**
 * URL / 域名脱敏工具。
 * S-2：日志只允许出现 eTLD+1，禁止完整 URL、查询串、用户名或 token。
 * 不依赖 PSL（依赖锁定 + 体积），用启发式取最后两段，足够日志脱敏用途。
 */
import { ERROR_CODES, VaultixError } from './errors.js';

export function redactDomain(input: string): string {
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase();
    const parts = host.split('.').filter(Boolean);
    if (parts.length <= 2) return host || '<invalid>';
    // co.uk / com.cn 等双后缀：保留三段，避免把 bbc.co.uk 缩成 co.uk
    const twoLevelSuffixes = new Set([
      'co.uk',
      'com.cn',
      'net.cn',
      'org.cn',
      'com.au',
      'co.jp',
      'co.nz',
      'com.br',
    ]);
    const maybeSuffix = parts.slice(-2).join('.');
    return twoLevelSuffixes.has(maybeSuffix)
      ? parts.slice(-3).join('.')
      : parts.slice(-2).join('.');
  } catch {
    return '<invalid>';
  }
}

/** S-3：所有发往后端的地址必须经此函数校验 */
export function assertHttpsOrLoopback(
  raw: string,
  { allowLoopback = false }: { allowLoopback?: boolean } = {},
): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new VaultixError(ERROR_CODES.PERMISSION_DENIED, 'INVALID_URL');
  }
  const isHttps = url.protocol === 'https:';
  const isLoopback =
    allowLoopback &&
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (!isHttps && !isLoopback) {
    throw new VaultixError(ERROR_CODES.PERMISSION_DENIED, 'INSECURE_SCHEME');
  }
  return url.origin;
}
