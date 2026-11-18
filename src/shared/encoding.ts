/** Base64 / 字节工具。所有实现基于 Web Crypto 可用的平台 API，无远程代码（M-4）。 */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded =
    normalized.length % 4 === 0 ? normalized : normalized + '='.repeat(4 - (normalized.length % 4));
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function utf8ToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** nonce 递增：KeePassRPC 要求响应 nonce = 请求 nonce + 1（大端） */
export function incrementNonce(nonce: Uint8Array): Uint8Array {
  const out = new Uint8Array(nonce);
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const next = (out[i] ?? 0) + 1;
    out[i] = next & 0xff;
    if (next <= 0xff) break;
  }
  return out;
}
