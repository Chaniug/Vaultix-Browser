/**
 * TOTP 生成（RFC 6238）与 otpauth 种子解析。
 *
 * 为什么需要：两个库给出「验证码」的方式不同——
 *  - KeePassXC：由适配器经 get-totp 实时取回 6 位码；
 *  - Bitwarden：login.totp 存的是 otpauth:// 种子 URI（旧条目可能是裸 Base32 密钥），
 *    必须由扩展自己算出当前验证码。
 * 统一填充服务用本模块把两种来源收敛成「即时验证码」，填充层无需关心来自哪个库。
 *
 * 纯计算：无存储、无网络、无远程代码（M-4）。
 */

/** WebCrypto 的 HMAC 摘要名；otpauth 里的 SHA1 / SHA256 / SHA512 会归一化到这里 */
export type OtpAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-512';

export interface OtpParams {
  readonly secret: Uint8Array;
  /** 验证码位数，常用 6，RFC 允许 1–10 */
  readonly digits: number;
  /** 时间步长（秒），常用 30 */
  readonly period: number;
  readonly algorithm: OtpAlgorithm;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const MAX_DIGITS = 10;
const DEFAULT_PERIOD_SECONDS = 30;

/** RFC 4648 Base32 解码；忽略空白与填充。遇到非法字符返回 null。 */
export function base32ToBytes(value: string): Uint8Array | null {
  const clean = value.replace(/\s+/g, '').replace(/=+$/, '').toUpperCase();
  if (clean.length === 0) return null;
  const out: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) return null;
    accumulator = ((accumulator << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((accumulator >>> bits) & 0xff);
    }
  }
  return out.length === 0 ? null : Uint8Array.from(out);
}

function parseDigits(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return parsed >= 1 && parsed <= MAX_DIGITS ? parsed : null;
}

function parsePeriod(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw)) return DEFAULT_PERIOD_SECONDS;
  const parsed = Number(raw);
  return parsed > 0 ? parsed : DEFAULT_PERIOD_SECONDS;
}

function parseAlgorithm(raw: string | null): OtpAlgorithm {
  const normalized = (raw ?? 'SHA1').toUpperCase().replace('-', '');
  if (normalized === 'SHA256') return 'SHA-256';
  if (normalized === 'SHA512') return 'SHA-512';
  return 'SHA-1';
}

/** 解析 otpauth://totp/... URI；非 TOTP（如计数器型 HOTP）或缺 secret 时返回 null。 */
export function parseOtpauth(uri: string): OtpParams | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'otpauth:' || url.hostname !== 'totp') return null;
  const secret = base32ToBytes(url.searchParams.get('secret') ?? '');
  if (secret === null) return null;
  return {
    secret,
    digits: parseDigits(url.searchParams.get('digits')) ?? 6,
    period: parsePeriod(url.searchParams.get('period')),
    algorithm: parseAlgorithm(url.searchParams.get('algorithm')),
  };
}

export function isOtpauthSeed(value: string): boolean {
  return value.startsWith('otpauth://');
}

/** 裸 Base32 密钥的默认参数（SHA-1 / 6 位 / 30 秒），与主流验证器一致。 */
export function defaultOtpParams(secret: Uint8Array): OtpParams {
  return { secret, digits: 6, period: DEFAULT_PERIOD_SECONDS, algorithm: 'SHA-1' };
}

function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

/** TS 5.7+ 的 Uint8Array<ArrayBufferLike> 不能直接赋给 DOM BufferSource；复制到独立 ArrayBuffer */
function bufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

async function hmacSha(
  secret: Uint8Array,
  message: Uint8Array,
  algorithm: OtpAlgorithm,
): Promise<Uint8Array> {
  const key = await subtle().importKey(
    'raw',
    bufferSource(secret),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  );
  const signature = await subtle().sign('HMAC', key, bufferSource(message));
  return new Uint8Array(signature);
}

/**
 * 生成当前时刻的 TOTP（RFC 6238，动态截取见 RFC 4226 第 5.3 节）。
 * nowMs 可注入，便于用 RFC 测试向量做单测。
 */
export async function generateTotp(params: OtpParams, nowMs: number = Date.now()): Promise<string> {
  const counter = Math.floor(Math.floor(nowMs / 1000) / params.period);
  const message = new ArrayBuffer(8);
  new DataView(message).setBigUint64(0, BigInt(counter), false);
  const digest = await hmacSha(params.secret, new Uint8Array(message), params.algorithm);

  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  const modulus = 10 ** params.digits;
  return String(binary % modulus).padStart(params.digits, '0');
}
