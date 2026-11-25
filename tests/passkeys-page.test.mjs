/**
 * 页面主世界的通行密钥提供方（jsdom）。
 * 重点验证三件事：
 *  1) 接管后能把 KeePassXC 的响应还原成浏览器认识的凭据对象（含两套 base64）；
 *  2) 提供方不可用时无缝回退到原生 navigator.credentials；
 *  3) conditional / silent mediation 不拦截，绝不弄坏站点原生通行密钥。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installPasskeyProvider } from '../.test-build/src/content/passkey-provider.js';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToStandardBase64,
} from '../.test-build/src/core/passkeys.js';

const bytes = (...values) => Uint8Array.from(values);

function setup(relay) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.com/',
  });
  const win = dom.window;
  const doc = win.document;
  const original = {
    create: async () => 'original-create',
    get: async () => 'original-get',
    store: async () => undefined,
    preventSilentAccess: async () => {},
  };
  Object.defineProperty(win.navigator, 'credentials', { configurable: true, value: original });

  const seen = [];
  doc.addEventListener('vaultix-passkeys-request', (event) => {
    const detail = event.detail;
    seen.push(detail);
    const reply = relay(detail);
    if (reply === undefined) return;
    doc.dispatchEvent(
      new win.CustomEvent('vaultix-passkeys-response', { detail: { id: detail.id, ...reply } }),
    );
  });

  installPasskeyProvider(win, doc);
  return { win, doc, seen };
}

const challenge = () => new Uint8Array(16).fill(7).buffer;

test('get：把 KeePassXC 的标准 base64 还原成 ArrayBuffer，id 用 base64url 解码', async () => {
  const signature = bytes(1, 2, 3, 4, 5);
  const authData = bytes(9, 9, 9);
  const clientData = bytes(4, 4, 4, 4);
  const { win } = setup((request) => {
    if (request.action === 'available') return { available: true };
    return {
      credential: {
        id: 'cred-id',
        type: 'public-key',
        authenticatorAttachment: 'platform',
        response: {
          authenticatorData: bytesToStandardBase64(authData),
          clientDataJSON: bytesToStandardBase64(clientData),
          signature: bytesToStandardBase64(signature),
          userHandle: bytesToBase64Url(bytes(3, 3)),
        },
        clientExtensionResults: {},
      },
    };
  });

  const credential = await win.navigator.credentials.get({
    publicKey: { challenge: challenge(), rpId: 'example.com' },
  });

  assert.equal(credential.type, 'public-key');
  assert.equal(credential.id, 'cred-id');
  assert.deepEqual([...new Uint8Array(credential.rawId)], [...base64UrlToBytes('cred-id')]);
  assert.deepEqual([...new Uint8Array(credential.response.signature)], [...signature]);
  assert.deepEqual([...new Uint8Array(credential.response.authenticatorData)], [...authData]);
  assert.deepEqual([...new Uint8Array(credential.response.clientDataJSON)], [...clientData]);
  assert.deepEqual([...new Uint8Array(credential.response.userHandle)], [3, 3]);
});

test('create：附带 SPKI 公钥、算法与 authenticatorData 辅助字段', async () => {
  const { win } = setup((request) => {
    if (request.action === 'available') return { available: true };
    return {
      credential: {
        id: 'new-cred',
        type: 'public-key',
        authenticatorAttachment: 'platform',
        response: {
          attestationObject: bytesToStandardBase64(bytes(6, 6, 6)),
          clientDataJSON: bytesToStandardBase64(bytes(7, 7, 7)),
          authenticatorData: bytesToStandardBase64(bytes(8, 8)),
          publicKey: bytesToStandardBase64(bytes(5, 5, 5, 5)),
          publicKeyAlgorithm: -7,
        },
      },
    };
  });

  const credential = await win.navigator.credentials.create({
    publicKey: {
      challenge: challenge(),
      rp: { id: 'example.com', name: 'Example' },
      user: { id: new Uint8Array([1, 2]).buffer, name: 'alice', displayName: 'Alice' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    },
  });

  assert.equal(credential.id, 'new-cred');
  assert.deepEqual([...new Uint8Array(credential.response.attestationObject)], [6, 6, 6]);
  assert.equal(credential.response.getPublicKeyAlgorithm(), -7);
  assert.deepEqual([...new Uint8Array(credential.response.getPublicKey())], [5, 5, 5, 5]);
  assert.deepEqual([...new Uint8Array(credential.response.getAuthenticatorData())], [8, 8]);
  assert.deepEqual(credential.response.getTransports(), ['internal']);
});

test('提供方不可用 → 完全交回原生实现', async () => {
  const { win, seen } = setup((request) =>
    request.action === 'available' ? { available: false } : undefined,
  );
  const result = await win.navigator.credentials.get({
    publicKey: { challenge: challenge(), rpId: 'example.com' },
  });
  assert.equal(result, 'original-get');
  // 只问了一次可用性，没有发起无关请求
  assert.deepEqual(
    seen.map((request) => request.action),
    ['available'],
  );
});

test('conditional / silent mediation 不拦截', async () => {
  const { win, seen } = setup((request) =>
    request.action === 'available' ? { available: true } : undefined,
  );
  const conditional = await win.navigator.credentials.get({
    publicKey: { challenge: challenge() },
    mediation: 'conditional',
  });
  assert.equal(conditional, 'original-get');
  const silent = await win.navigator.credentials.get({
    publicKey: { challenge: challenge() },
    mediation: 'silent',
  });
  assert.equal(silent, null);
  assert.deepEqual(seen, []);
});

test('KeePassXC 返回错误码 → 抛出对应的 DOMException', async () => {
  const { win } = setup((request) => {
    if (request.action === 'available') return { available: true };
    return { errorCode: 15 };
  });
  await assert.rejects(
    () => win.navigator.credentials.get({ publicKey: { challenge: challenge() } }),
    (error) => error.name === 'NotAllowedError',
  );
});

test('域名与 RP ID 不匹配 → SecurityError', async () => {
  const { win } = setup((request) => {
    if (request.action === 'available') return { available: true };
    return { errorCode: 28 };
  });
  await assert.rejects(
    () => win.navigator.credentials.get({ publicKey: { challenge: challenge() } }),
    (error) => error.name === 'SecurityError',
  );
});

test('转发给中继的请求里 challenge 已是 base64url，且不含 origin', async () => {
  const { win, seen } = setup((request) => {
    if (request.action === 'available') return { available: true };
    return { credential: { id: 'x', response: {} } };
  });
  await win.navigator.credentials.get({
    publicKey: { challenge: challenge(), rpId: 'example.com' },
  });
  const request = seen.find((item) => item.action === 'get');
  assert.equal(typeof request.options.challenge, 'string');
  assert.equal(request.options.challenge.includes('+'), false);
  assert.equal('origin' in request, false);
});
