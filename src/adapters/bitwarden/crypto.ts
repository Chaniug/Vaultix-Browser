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

/** HKDF-Expand（RFC 5869 单步）：Bitwarden 以 masterKey 作为 PRK，info 固定 'enc' / 'mac'。 */
async function hkdfExpand(prk: Uint8Array, info: 'enc' | 'mac'): Promise<Uint8Array> {
  const key = await subtle().importKey(
    'raw',
    bufferSource(prk),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const input = new Uint8Array([...utf8ToBytes(info), 0x01]);
  return new Uint8Array(await subtle().sign('HMAC', key, bufferSource(input)));
}

/**
 * 拉伸主密钥：HKDF-Expand(masterKey, 'enc') 与 HKDF-Expand(masterKey, 'mac') 各 32 字节。
 * 前 32 字节用于 AES、后 32 字节用于 HMAC，因此拼接后为 64 字节。
 */
export async function stretchMasterKey(masterKey: Uint8Array): Promise<Uint8Array> {
  return concatBytes(await hkdfExpand(masterKey, 'enc'), await hkdfExpand(masterKey, 'mac'));
}

/** 服务端认证哈希：PBKDF2(masterKey, masterPassword, 1)，Base64 后作为 password 字段发送。 */
export async function hashMasterPassword(
  masterKey: Uint8Array,
  masterPassword: string,
): Promise<string> {
  return bytesToBase64(await pbkdf2(masterKey, utf8ToBytes(masterPassword), 1));
}

/**
 * 解析 Bitwarden EncString：形如 `2.<ivB64>|<ctB64>|<macB64>`。
 * 兼容历史测试夹具中 `2.<iv>.<ct>.<mac>` 的写法，但线上协议使用竖线分隔。
 */
function parseEncString(value: string): {
  iv: Uint8Array;
  ciphertext: Uint8Array;
  mac: Uint8Array;
} {
  const body = value.startsWith('2.') ? value.slice(2) : value;
  const parts = body.includes('|') ? body.split('|') : body.split('.');
  if (parts.length < 2) throw new VaultixError(ERROR_CODES.DECRYPT_FAILED);
  const iv = base64ToBytes(parts[0] ?? '');
  const ciphertext = base64ToBytes(parts[1] ?? '');
  const mac =
    typeof parts[2] === 'string' && parts[2].length > 0
      ? base64ToBytes(parts[2])
      : new Uint8Array(0);
  if (iv.length !== 16 || ciphertext.length === 0) {
    throw new VaultixError(ERROR_CODES.DECRYPT_FAILED);
  }
  return { iv, ciphertext, mac };
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

/**
 * 解密 Protected Symmetric Key。
 * profile.key 是 type=2 EncString，需先用 HKDF 拉伸出的 enc/mac 密钥校验 MAC 并解密，
 * 得到 64 字节用户对称密钥（前 32 enc、后 32 mac）。
 */
export async function decryptSymmetricKey(
  protectedKey: string,
  stretchedKey: Uint8Array,
): Promise<Uint8Array> {
  if (stretchedKey.length < 64) throw new VaultixError(ERROR_CODES.DECRYPT_FAILED);
  try {
    const { iv, ciphertext, mac } = parseEncString(protectedKey);
    if (mac.length === 0) throw new VaultixError(ERROR_CODES.DECRYPT_FAILED);
    await verifyMac(iv, ciphertext, mac, stretchedKey.slice(32, 64));
    const plain = await aesCbcDecrypt(ciphertext, stretchedKey.slice(0, 32), iv);
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
  if (!value.startsWith('2.') || symmetricKey.length < 64) {
    throw new VaultixError(ERROR_CODES.DECRYPT_FAILED);
  }
  try {
    const { iv, ciphertext, mac } = parseEncString(value);
    if (mac.length === 0) throw new VaultixError(ERROR_CODES.DECRYPT_FAILED);
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
  return `2.${bytesToBase64(iv)}|${bytesToBase64(ciphertext)}|${bytesToBase64(mac)}`;
}
