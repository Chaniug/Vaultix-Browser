/**
 * 通行密钥的编码与序列化。
 * 这里锁死 KeePassXC 的两套 base64 约定（请求 base64url；响应除 id 外都是标准 base64），
 * 以及版本门槛——弄反不会报错，只会静默失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToStandardBase64,
  serializeCredentialCreationOptions,
  serializeCredentialRequestOptions,
  versionAtLeast,
} from '../.test-build/src/core/passkeys.js';

const bytes = (...values) => Uint8Array.from(values);
const buffer = (...values) => bytes(...values).buffer;

test('base64url 编解码：URL 安全字符且无填充', () => {
  const raw = bytes(0xfb, 0xff, 0xbf, 0x00, 0x01);
  const encoded = bytesToBase64Url(raw);
  assert.equal(encoded.includes('+'), false);
  assert.equal(encoded.includes('/'), false);
  assert.equal(encoded.includes('='), false);
  assert.deepEqual([...base64UrlToBytes(encoded)], [...raw]);
  // 解码器同时接受带填充的标准 base64
  assert.deepEqual([...base64UrlToBytes(bytesToStandardBase64(raw))], [...raw]);
});

test('create 选项：challenge / user.id / excludeCredentials 都转 base64url', () => {
  const challenge = buffer(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16);
  const request = serializeCredentialCreationOptions({
    challenge,
    rp: { id: 'example.com', name: 'Example' },
    user: { id: buffer(9, 8, 7), name: 'alice', displayName: 'Alice' },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    excludeCredentials: [{ type: 'public-key', id: buffer(5, 5), transports: ['internal', 'usb'] }],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    attestation: 'none',
    timeout: 60_000,
  });

  assert.equal(request.challenge, bytesToBase64Url(new Uint8Array(challenge)));
  assert.deepEqual(request.rp, { id: 'example.com', name: 'Example' });
  assert.equal(request.user.id, bytesToBase64Url(bytes(9, 8, 7)));
  assert.equal(request.user.name, 'alice');
  assert.deepEqual(request.excludeCredentials, [
    { type: 'public-key', id: bytesToBase64Url(bytes(5, 5)), transports: ['internal', 'usb'] },
  ]);
  assert.equal(request.pubKeyCredParams.length, 2);
  assert.deepEqual(request.authenticatorSelection, {
    residentKey: 'preferred',
    userVerification: 'preferred',
  });
  assert.equal(request.attestation, 'none');
  assert.equal(request.timeout, 60_000);
});

test('create 选项：缺少 challenge 时返回 null，由调用方回退原生实现', () => {
  assert.equal(serializeCredentialCreationOptions({}), null);
  assert.equal(serializeCredentialCreationOptions(null), null);
  assert.equal(serializeCredentialCreationOptions({ challenge: 'not-binary' }), null);
});

test('get 选项：challenge / allowCredentials 转 base64url，可选字段缺失时不写入', () => {
  const request = serializeCredentialRequestOptions({
    challenge: buffer(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1),
    allowCredentials: [{ type: 'public-key', id: buffer(2, 2), transports: ['internal'] }],
    userVerification: 'required',
  });
  assert.equal(typeof request.challenge, 'string');
  assert.equal(request.rpId, undefined);
  assert.equal(request.userVerification, 'required');
  assert.deepEqual(request.allowCredentials, [
    { type: 'public-key', id: bytesToBase64Url(bytes(2, 2)), transports: ['internal'] },
  ]);
});

test('版本比较：2.7.7 是通行密钥门槛', () => {
  assert.equal(versionAtLeast('2.7.6', 2, 7, 7), false);
  assert.equal(versionAtLeast('2.7.7', 2, 7, 7), true);
  assert.equal(versionAtLeast('2.8.0', 2, 7, 7), true);
  assert.equal(versionAtLeast('2.10.0', 2, 7, 7), true);
  assert.equal(versionAtLeast('3.0.0', 2, 7, 7), true);
  assert.equal(versionAtLeast('2.7', 2, 7, 7), false);
  assert.equal(versionAtLeast('abc', 2, 7, 7), false);
  assert.equal(versionAtLeast(null, 2, 7, 7), false);
  assert.equal(versionAtLeast(undefined, 2, 7, 7), false);
});
