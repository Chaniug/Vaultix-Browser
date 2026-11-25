/**
 * TOTP 生成：用 RFC 6238 附录 B 的官方测试向量验证（SHA-1 / SHA-256 / SHA-512）。
 * 向量是协议标准的权威数据，不是自己造的桩——避免再次出现"测试自洽但真机不通"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32ToBytes, generateTotp, parseOtpauth } from '../.test-build/src/core/totp.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 6238：密钥是 "1234567890" 不断重复后截取前 N 字节（32 / 64 不是 10 的整数倍） */
const seed = (length) => base32(Buffer.from('1234567890'.repeat(10).slice(0, length)));

const VECTORS = [
  // [算法, 密钥字节数, 时间(秒), 期望的 8 位码]
  ['SHA1', 20, 59, '94287082'],
  ['SHA1', 20, 1111111109, '07081804'],
  ['SHA256', 32, 59, '46119246'],
  ['SHA256', 32, 1111111109, '68084774'],
  ['SHA512', 64, 59, '90693936'],
  ['SHA512', 64, 1111111109, '25091201'],
];

for (const [algorithm, length, seconds, expected] of VECTORS) {
  test(`RFC 6238 向量：${algorithm} @ T=${seconds}s → ${expected}`, async () => {
    const params = parseOtpauth(
      `otpauth://totp/RFC?secret=${seed(length)}&digits=8&algorithm=${algorithm}`,
    );
    assert.notEqual(params, null);
    assert.equal(await generateTotp(params, seconds * 1000), expected);
  });
}

test('默认参数为 6 位 / 30 秒 / SHA-1', () => {
  const params = parseOtpauth(`otpauth://totp/Issuer:alice?secret=${seed(20)}`);
  assert.notEqual(params, null);
  assert.equal(params.digits, 6);
  assert.equal(params.period, 30);
  assert.equal(params.algorithm, 'SHA-1');
});

test('不同位数与周期从 URI 读取', () => {
  const params = parseOtpauth(
    `otpauth://totp/x?secret=${seed(20)}&digits=7&period=60&algorithm=SHA256`,
  );
  assert.notEqual(params, null);
  assert.equal(params.digits, 7);
  assert.equal(params.period, 60);
  assert.equal(params.algorithm, 'SHA-256');
});

test('非 TOTP 类型或缺少 secret 时拒绝解析，不做猜测', () => {
  assert.equal(parseOtpauth(`otpauth://hotp/x?secret=${seed(20)}`), null);
  assert.equal(parseOtpauth('otpauth://totp/x'), null);
  assert.equal(parseOtpauth('https://example.com/?secret=ABC'), null);
  assert.equal(parseOtpauth('not a uri'), null);
});

test('Base32 解码：合法 / 小写、空白与填充均可 / 非法字符拒绝', () => {
  assert.deepEqual([...base32ToBytes(base32(Buffer.from('Vaultix')))], [...Buffer.from('Vaultix')]);
  assert.deepEqual([...base32ToBytes('jbsw y3dp==')], [...base32ToBytes('JBSWY3DP')]);
  assert.equal(base32ToBytes(''), null);
  assert.equal(base32ToBytes('ABC1'), null);
});
