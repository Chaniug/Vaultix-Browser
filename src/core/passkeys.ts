/**
 * 通行密钥的线协议工具：base64 编码与 WebAuthn 选项序列化。
 *
 * KeePassXC 的编码约定并不统一（依据 2.8 源码 BrowserPasskeys / PasskeyUtils）：
 *  - 发给它：`challenge`、`user.id`、`excludeCredentials[].id`、`allowCredentials[].id` 均为 **base64url**；
 *  - 它返回：`attestationObject` / `authenticatorData` / `clientDataJSON` / `signature`
 *    是**标准 base64**，而 `id`（credential id）是 **base64url**。
 * 弄反任何一处都不会报错，只会静默失败，因此集中在这里并用测试锁死。
 *
 * 本模块不依赖浏览器扩展 API，可同时被页面主世界脚本与后台代码引用（M-4）。
 */
import { base64ToBytes, bytesToBase64 } from '../shared/encoding.js';

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(value: string): Uint8Array {
  return base64ToBytes(value);
}

export function bytesToStandardBase64(bytes: Uint8Array): string {
  return bytesToBase64(bytes);
}

/**
 * 版本比较（形如 "2.8.0"）。解析失败一律按「不满足」处理——
 * 宁可少开一个功能，也不要对着未知版本的 KeePassXC 发它不认识的请求。
 */
export function versionAtLeast(
  version: string | null | undefined,
  major: number,
  minor: number,
  patch: number,
): boolean {
  if (typeof version !== 'string') return false;
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  const [a, b, c] = parts;
  if (a === undefined || b === undefined || c === undefined) return false;
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return false;
  if (a !== major) return a > major;
  if (b !== minor) return b > minor;
  return c >= patch;
}

/**
 * 只接受真正的二进制（ArrayBuffer / TypedArray）→ base64url。
 * 页面传入字符串 challenge 本身就是无效的 WebAuthn 参数：返回 undefined，
 * 让调用方回退到浏览器原生实现，由浏览器抛出正确的 TypeError。
 */
function binaryToBase64Url(value: unknown): string | undefined {
  if (value instanceof ArrayBuffer) return bytesToBase64Url(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return bytesToBase64Url(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as Record<string, unknown>;
}

/** 只保留 JSON 可安全传输的原始值（丢弃函数 / Symbol / 二进制） */
function plainClone(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record === null) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      out[key] = item;
    } else if (Array.isArray(item)) {
      const list = item.filter(
        (entry) =>
          typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean',
      );
      if (list.length > 0) out[key] = list;
    }
  }
  return out;
}

function serializeCredentialDescriptors(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Record<string, unknown>[] = [];
  for (const entry of value) {
    const descriptor = asRecord(entry);
    if (descriptor === null) continue;
    const id = binaryToBase64Url(descriptor.id);
    if (id === undefined) continue;
    const item: Record<string, unknown> = { type: 'public-key', id };
    if (Array.isArray(descriptor.transports)) {
      item.transports = descriptor.transports.filter((t): t is string => typeof t === 'string');
    }
    out.push(item);
  }
  return out;
}

/**
 * navigator.credentials.create 的 publicKey 选项 → 可 JSON 传输的请求体。
 * challenge 缺失或无法编码时返回 null，调用方应回退到浏览器原生实现。
 */
export function serializeCredentialCreationOptions(
  options: unknown,
): Record<string, unknown> | null {
  const source = asRecord(options);
  if (source === null) return null;
  const challenge = binaryToBase64Url(source.challenge);
  if (challenge === undefined) return null;

  const request: Record<string, unknown> = { challenge };

  const rp = asRecord(source.rp);
  if (rp !== null) {
    const rpOut: Record<string, unknown> = {};
    if (typeof rp.id === 'string') rpOut.id = rp.id;
    if (typeof rp.name === 'string') rpOut.name = rp.name;
    request.rp = rpOut;
  }

  const user = asRecord(source.user);
  if (user !== null) {
    const userId = binaryToBase64Url(user.id);
    if (userId !== undefined) {
      const userOut: Record<string, unknown> = { id: userId };
      if (typeof user.name === 'string') userOut.name = user.name;
      if (typeof user.displayName === 'string') userOut.displayName = user.displayName;
      request.user = userOut;
    }
  }

  const descriptors = serializeCredentialDescriptors(source.excludeCredentials);
  if (descriptors !== undefined) request.excludeCredentials = descriptors;
  if (Array.isArray(source.pubKeyCredParams)) {
    request.pubKeyCredParams = source.pubKeyCredParams.filter((item) => {
      const record = asRecord(item);
      return record !== null && typeof record.alg === 'number';
    });
  }
  const selection = plainClone(source.authenticatorSelection);
  if (selection !== undefined) request.authenticatorSelection = selection;
  if (typeof source.attestation === 'string') request.attestation = source.attestation;
  if (typeof source.timeout === 'number') request.timeout = source.timeout;
  const extensions = plainClone(source.extensions);
  if (extensions !== undefined) request.extensions = extensions;

  return request;
}

/** navigator.credentials.get 的 publicKey 选项 → 可 JSON 传输的请求体 */
export function serializeCredentialRequestOptions(
  options: unknown,
): Record<string, unknown> | null {
  const source = asRecord(options);
  if (source === null) return null;
  const challenge = binaryToBase64Url(source.challenge);
  if (challenge === undefined) return null;

  const request: Record<string, unknown> = { challenge };
  if (typeof source.rpId === 'string' && source.rpId.length > 0) request.rpId = source.rpId;
  const descriptors = serializeCredentialDescriptors(source.allowCredentials);
  if (descriptors !== undefined) request.allowCredentials = descriptors;
  if (typeof source.userVerification === 'string')
    request.userVerification = source.userVerification;
  if (typeof source.timeout === 'number') request.timeout = source.timeout;
  const extensions = plainClone(source.extensions);
  if (extensions !== undefined) request.extensions = extensions;

  return request;
}
