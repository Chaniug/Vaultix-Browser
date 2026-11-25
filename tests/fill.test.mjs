/**
 * 统一填充解析：把条目 + 字段解析成 FillPlan。
 * 重点是验证码的两个来源——KeePassXC 的即时码、Bitwarden 的 otpauth 种子 / 裸 Base32 密钥。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFillPlan, hasTotpSeed, resolveTotpCode } from '../.test-build/src/core/fill.js';

/** RFC 6238 的 SHA-1 测试向量：T=59s 时 8 位码为 94287082 */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const T59 = 59_000;

const item = (extra = {}) => ({
  id: 'item-1',
  source: 'bitwarden',
  name: 'Work Mail',
  username: 'alice',
  password: 's3cret',
  ...extra,
});

test('otpauth 种子：算出 RFC 6238 向量对应的即时码', async () => {
  const code = await resolveTotpCode(`otpauth://totp/x?secret=${RFC_SECRET}&digits=8`, {
    nowMs: T59,
  });
  assert.equal(code, '94287082');
});

test('裸 Base32 密钥（Bitwarden 旧条目）：按默认参数计算', async () => {
  assert.equal(await resolveTotpCode(RFC_SECRET, { nowMs: T59 }), '287082');
});

test('适配器已给出的即时码原样使用', async () => {
  assert.equal(await resolveTotpCode('654321', { nowMs: T59 }), '654321');
});

test('实时取回的验证码优先于种子', async () => {
  assert.equal(await resolveTotpCode(RFC_SECRET, { nowMs: T59, freshTotp: '111222' }), '111222');
  // 实时值不是合法验证码时回落到种子
  assert.equal(await resolveTotpCode(RFC_SECRET, { nowMs: T59, freshTotp: 'garbage' }), '287082');
});

test('无法解析时不做猜测性填充', async () => {
  assert.equal(await resolveTotpCode(undefined, { nowMs: T59 }), undefined);
  assert.equal(await resolveTotpCode('', { nowMs: T59 }), undefined);
  assert.equal(await resolveTotpCode('otpauth://hotp/x?secret=ABC', { nowMs: T59 }), undefined);
  assert.equal(await resolveTotpCode('!!not-base32!!', { nowMs: T59 }), undefined);
});

test('buildFillPlan：只写请求的字段，空字段不覆盖输入框', async () => {
  const plan = await buildFillPlan(item({ username: '' }), ['username', 'password'], {
    nowMs: T59,
  });
  assert.deepEqual(plan, { password: 's3cret' });
});

test('buildFillPlan：不请求验证码就不解析', async () => {
  const plan = await buildFillPlan(item({ totp: RFC_SECRET }), ['username', 'password'], {
    nowMs: T59,
  });
  assert.deepEqual(plan, { username: 'alice', password: 's3cret' });
});

test('buildFillPlan：请求验证码时给出即时码', async () => {
  const plan = await buildFillPlan(item({ totp: RFC_SECRET }), ['totp'], { nowMs: T59 });
  assert.deepEqual(plan, { totp: '287082' });
});

test('hasTotpSeed', () => {
  assert.equal(hasTotpSeed(undefined), false);
  assert.equal(hasTotpSeed(''), false);
  assert.equal(hasTotpSeed('ABC'), true);
});
