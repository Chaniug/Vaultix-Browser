/**
 * 统一填充解析：把「某条凭证 + 要填哪些字段」解析成可直接写入输入框的 FillPlan。
 *
 * 这是两个库共用一套填充体系的汇聚点——popup 按钮与页面内浮层都只发出
 * 「来源 + 条目 id + 字段」，由这里（在 background 中调用）取出真实值：
 *  - 用户名 / 密码直接取自条目；
 *  - 验证码统一解析成「即时验证码」（见 core/totp.ts），不再把 otpauth 种子写进输入框。
 * UI 层因此不需要持有密码，也不需要知道凭证来自哪个库。
 */
import type { CredentialItem } from './types.js';
import {
  base32ToBytes,
  defaultOtpParams,
  generateTotp,
  isOtpauthSeed,
  parseOtpauth,
} from './totp.js';

export type FillField = 'username' | 'password' | 'totp';

export interface FillPlan {
  readonly username?: string;
  readonly password?: string;
  readonly totp?: string;
}

export interface ResolveTotpOptions {
  /** 适配器实时取回的验证码（KeePassXC get-totp）；有效时优先于种子计算 */
  readonly freshTotp?: string;
  /** 当前时间（毫秒），可注入便于单测 */
  readonly nowMs?: number;
}

const PLAIN_CODE = /^\d{4,10}$/;

/**
 * 把条目的 totp 字段解析成即时验证码。
 * 顺序：实时码 → 已是纯数字的即时码 → otpauth 种子 → 裸 Base32 密钥。
 * 无法解析时返回 undefined（绝不做猜测性填充）。
 */
export async function resolveTotpCode(
  seed: string | undefined,
  options: ResolveTotpOptions = {},
): Promise<string | undefined> {
  const fresh = options.freshTotp;
  if (fresh !== undefined && PLAIN_CODE.test(fresh)) return fresh;
  if (seed === undefined || seed.length === 0) return undefined;
  if (PLAIN_CODE.test(seed)) return seed;

  const params = isOtpauthSeed(seed)
    ? parseOtpauth(seed)
    : (() => {
        const secret = base32ToBytes(seed);
        return secret === null ? null : defaultOtpParams(secret);
      })();
  if (params === null) return undefined;
  return generateTotp(params, options.nowMs ?? Date.now());
}

export function hasTotpSeed(seed: string | undefined): boolean {
  return seed !== undefined && seed.length > 0;
}

/** 按请求字段构造填充计划；条目里为空的字段不写入（避免把输入框清空）。 */
export async function buildFillPlan(
  item: CredentialItem,
  fields: readonly FillField[],
  options: ResolveTotpOptions = {},
): Promise<FillPlan> {
  const plan: { username?: string; password?: string; totp?: string } = {};
  if (fields.includes('username') && item.username.length > 0) plan.username = item.username;
  if (fields.includes('password') && item.password.length > 0) plan.password = item.password;
  if (fields.includes('totp')) {
    const code = await resolveTotpCode(item.totp, options);
    if (code !== undefined) plan.totp = code;
  }
  return plan;
}
