/**
 * Bitwarden 加密链路（只读所需的最小子集），全部基于 Web Crypto API，无远程代码（M-4）。
 *
 * 参考 Bitwarden 公开的加密方案：PBKDF2-HMAC-SHA256 → 主密钥 → 拉伸密钥 →
 * 解密受保护对称密钥 → AES-256-CBC 解密字段（type=2，带 HMAC-SHA256）。
 * 实现为协议重实现，不复制 bitwarden/clients 源码（L-3）。
 */
import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from '../../shared/encoding.js';
import { ERROR_CODES, VaultixError } from '../../shared/errors.js';

const PBKDF2_ITERATIONS = 100_000;
const KEY_BITS = 256;

function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

/** TS 5.9+ 的 Uint8Array<ArrayBufferLike> 不能直接赋给 DOM BufferSource；复制到独立 ArrayBuffer */
function bufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

async function pbkdf2(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const baseKey = await subtle().importKey('raw', bufferSource(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle().deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: bufferSource(salt),
      iterations,
    },
    baseKey,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** 主密钥：PBKDF2(masterPassword, lowercase(email), iterations) */
export function deriveMasterKey(
  email: string,
  masterPassword: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  return pbkdf2(utf8ToBytes(masterPassword), utf8ToBytes(email.toLowerCase()), iterations);
}

/** 拉伸密钥：PBKDF2(masterKey, masterPassword, iterations)，用于登录哈希 */
export function deriveStretchedKey(
  masterKey: Uint8Array,
  masterPassword: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  return pbkdf2(masterKey, utf8ToBytes(masterPassword), iterations);
}

async function aesCbcDecrypt(
  data: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await subtle().importKey('raw', bufferSource(key), { name: 'AES-CBC' }, false, [
    'decrypt',
  ]);
  const plain = await subtle().decrypt(
    { name: 'AES-CBC', iv: bufferSource(iv) },
    cryptoKey,
    bufferSource(data),
  );
  return new Uint8Array(plain);
}

/** 解密受保护对称密钥：AES-CBC(masterKey[0:32], iv || ciphertext) */
export async function decryptSymmetricKey(
  protectedKey: string,
  masterKey: Uint8Array,
): Promise<Uint8Array> {
  if (masterKey.length < 32) throw new VaultixError(ERROR_CODES.DECRYPT_FAILED);
  const encrypted = base64ToBytes(protectedKey);
  if (encrypted.length <= 16) throw new VaultixError(ERROR_CODES.DECRYPT_FAILED);
  try {
    const plain = await aesCbcDecrypt(
      encrypted.slice(16),
      masterKey.slice(0, 32),
      encrypted.slice(0, 16),
    );
    if (plain.length < 64) throw new VaultixError(ERROR_CODES.DECRYPT_FAILED);
    return plain;
  } catch (error) {
    if (error instanceof VaultixError) throw error;
    throw new VaultixError(ERROR_CODES.DECRYPT_FAILED);
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

async function verifyMac(
  iv: Uint8Array,
  ciphertext: Uint8Array,
  expected: Uint8Array,
  macKey: Uint8Array,
): Promise<void> {
  if (expected.length === 0) return;
  const key = await subtle().importKey(
    'raw',
    bufferSource(macKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = new Uint8Array(
    await subtle().sign('HMAC', key, bufferSource(concatBytes(iv, ciphertext))),
  );
  if (!constantTimeEqual(signed, expected)) {
    throw new VaultixError(ERROR_CODES.DECRYPT_FAILED);
  }
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 解密 Bitwarden 字段字符串（type=2：AES-256-CBC + HMAC-SHA256） */
export async function decryptCipherString(
  value: string,
  symmetricKey: Uint8Array,
): Promise<string> {
  if (typeof value !== 'string' || value.length === 0) return '';
  const parts = value.split('.');
  if (parts.length < 4 || parts[0] !== '2' || symmetricKey.length < 64) {
    throw new VaultixError(ERROR_CODES.DECRYPT_FAILED);
  }
  try {
    const iv = base64ToBytes(parts[1] ?? '');
    const ciphertext = base64ToBytes(parts[2] ?? '');
    const mac = base64ToBytes(parts[3] ?? '');
    await verifyMac(iv, ciphertext, mac, symmetricKey.slice(32, 64));
    const plain = await aesCbcDecrypt(ciphertext, symmetricKey.slice(0, 32), iv);
    return bytesToUtf8(plain);
  } catch (error) {
    if (error instanceof VaultixError) throw error;
    throw new VaultixError(ERROR_CODES.DECRYPT_FAILED);
  }
}

/** AES-256-CBC 加密 + PKCS7 填充（WebCrypto 自动处理填充） */
async function aesCbcEncrypt(
  data: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await subtle().importKey('raw', bufferSource(key), { name: 'AES-CBC' }, false, [
    'encrypt',
  ]);
  const encrypted = await subtle().encrypt(
    { name: 'AES-CBC', iv: bufferSource(iv) },
    cryptoKey,
    bufferSource(data),
  );
  return new Uint8Array(encrypted);
}

/** 加密 Bitwarden 字段字符串为 type=2 格式（与 decryptCipherString 对称） */
export async function encryptCipherString(
  value: string,
  symmetricKey: Uint8Array,
): Promise<string> {
  if (symmetricKey.length < 64) throw new VaultixError(ERROR_CODES.DECRYPT_FAILED);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const ciphertext = await aesCbcEncrypt(utf8ToBytes(value), symmetricKey.slice(0, 32), iv);
  const macKey = await subtle().importKey(
    'raw',
    bufferSource(symmetricKey.slice(32, 64)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await subtle().sign('HMAC', macKey, bufferSource(concatBytes(iv, ciphertext))),
  );
  return `2.${bytesToBase64(iv)}.${bytesToBase64(ciphertext)}.${bytesToBase64(mac)}`;
}
