/**
 * T-1 / DEC-010：写回能力测试。
 * Bitwarden 加密往返 + API 请求体；KeePassRPC set-login 加密往返。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import nodeCrypto from 'node:crypto';
import { createBitwardenAdapter } from '../.test-build/src/adapters/bitwarden/index.js';
import {
  deriveMasterKey,
  decryptCipherString,
  encryptCipherString,
} from '../.test-build/src/adapters/bitwarden/crypto.js';
import { createKeePassRpcAdapter } from '../.test-build/src/adapters/keepassrpc/index.js';
import {
  base64ToBytes,
  bytesToBase64,
  incrementNonce,
  bytesToUtf8,
  utf8ToBytes,
} from '../.test-build/src/shared/encoding.js';

const HOST_KEY = nacl.box.keyPair();
const EMAIL = 'save@example.com';
const PASSWORD = 'write-test-password';
const ITER = 1000;
const MASTER_KEY = await deriveMasterKey(EMAIL, PASSWORD, ITER);

function symmetricKey() {
  return nodeCrypto.randomBytes(64);
}

function protectedKey(sym) {
  const iv = nodeCrypto.randomBytes(16);
  const cipher = nodeCrypto.createCipheriv('aes-256-cbc', MASTER_KEY.subarray(0, 32), iv);
  return Buffer.concat([iv, Buffer.concat([cipher.update(sym), cipher.final()])]).toString(
    'base64',
  );
}

function installSaveFetchStub(sym) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    let body = {};
    if (url.includes('/api/accounts/prelogin')) {
      body = { kdf: 0, kdfIterations: ITER };
    } else if (url.includes('/connect/token')) {
      body = { access_token: 'save-token', expires_in: 3600, token_type: 'Bearer' };
    } else if (url.includes('/api/sync')) {
      body = { profile: { key: protectedKey(sym) }, ciphers: [] };
    } else if (url.endsWith('/api/ciphers') && init.method === 'POST') {
      body = { id: 'new-cipher-id' };
    } else if (url.includes('/api/ciphers/') && init.method === 'PUT') {
      body = {};
    } else {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test('encryptCipherString 与 decryptCipherString 往返一致', async () => {
  const key = symmetricKey();
  const plain = '保存的密码 🔐';
  const encrypted = await encryptCipherString(plain, key);
  assert.ok(encrypted.startsWith('2.'));
  assert.equal(await decryptCipherString(encrypted, key), plain);

  // 篡改 HMAC 后必须解密失败
  const parts = encrypted.split('.');
  const mac = base64ToBytes(parts[3]);
  mac[0] ^= 0x01;
  parts[3] = Buffer.from(mac).toString('base64');
  await assert.rejects(
    () => decryptCipherString(parts.join('.'), key),
    (error) => error.code === 'DECRYPT_FAILED',
  );
});

test('Bitwarden save 新建：字段加密且请求体不含明文', async () => {
  const sym = symmetricKey();
  const stub = installSaveFetchStub(sym);
  try {
    const adapter = createBitwardenAdapter({
      serverUrl: 'https://vault.example.test',
      mode: 'vaultwarden',
      email: EMAIL,
      masterPassword: PASSWORD,
      kdfIterations: ITER,
    });
    await adapter.login();
    const result = await adapter.save({
      url: 'https://mail.example.com/login',
      username: 'alice',
      password: 'super-secret',
    });
    assert.deepEqual(result, {
      ok: true,
      source: 'bitwarden',
      id: 'new-cipher-id',
      created: true,
    });

    const post = stub.calls.find(
      (call) => call.url.endsWith('/api/ciphers') && call.init.method === 'POST',
    );
    assert.ok(post, '应发出 POST /api/ciphers');
    const payload = JSON.parse(post.init.body);
    assert.equal(payload.type, 1);
    assert.equal(payload.login.username.startsWith('2.'), true);
    assert.equal(payload.login.password.startsWith('2.'), true);
    assert.equal(post.init.body.includes('super-secret'), false, '请求体不得含明文');
    assert.equal(await decryptCipherString(payload.login.password, sym), 'super-secret');
    assert.equal(await decryptCipherString(payload.name, sym), 'mail.example.com');
  } finally {
    stub.restore();
  }
});

test('Bitwarden save 更新：带 uuid 走 PUT', async () => {
  const sym = symmetricKey();
  const stub = installSaveFetchStub(sym);
  try {
    const adapter = createBitwardenAdapter({
      serverUrl: 'https://vault.example.test',
      mode: 'vaultwarden',
      email: EMAIL,
      masterPassword: PASSWORD,
      kdfIterations: ITER,
    });
    await adapter.login();
    const result = await adapter.save({
      url: 'https://mail.example.com/login',
      username: 'alice',
      password: 'new-password',
      uuid: 'existing-id',
    });
    assert.equal(result.ok, true);
    assert.equal(result.created, false);
    assert.equal(result.id, 'existing-id');
    const put = stub.calls.find((call) => call.init.method === 'PUT');
    assert.ok(put);
    assert.equal(put.url, 'https://vault.example.test/api/ciphers/existing-id');
  } finally {
    stub.restore();
  }
});

class SaveMockTransport {
  constructor() {
    this.connected = false;
    this.clientPublicKey = null;
    this.actions = [];
  }
  async connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
  async send(message) {
    if (message.action === 'change-public-keys') {
      this.clientPublicKey = base64ToBytes(message.publicKey);
      return {
        action: message.action,
        publicKey: bytesToBase64(HOST_KEY.publicKey),
        success: 'true',
        nonce: message.nonce,
        clientID: message.clientID,
      };
    }
    const nonce = base64ToBytes(message.nonce);
    const opened = nacl.box.open(
      base64ToBytes(message.message),
      nonce,
      this.clientPublicKey,
      HOST_KEY.secretKey,
    );
    assert.ok(opened);
    const request = JSON.parse(bytesToUtf8(opened));
    this.actions.push({ action: request.action, payload: request });
    const payload = {
      success: 'true',
      ...(request.action === 'associate' ? { id: 'save-client' } : {}),
      ...(request.action === 'set-login' ? { uuid: 'kp-entry-id' } : {}),
    };
    const encrypted = nacl.box(
      utf8ToBytes(JSON.stringify(payload)),
      nonce,
      this.clientPublicKey,
      HOST_KEY.secretKey,
    );
    return {
      action: request.action,
      message: bytesToBase64(encrypted),
      nonce: bytesToBase64(incrementNonce(nonce)),
      clientID: message.clientID,
      success: 'true',
    };
  }
}

test('KeePassRPC set-login 新建与更新均加密发送', async () => {
  const transport = new SaveMockTransport();
  const adapter = createKeePassRpcAdapter({}, transport);
  await adapter.associate();

  const created = await adapter.save({
    url: 'https://site.example.test',
    username: 'bob',
    password: 'kp-secret',
    folder: 'Browser',
  });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.id, 'kp-entry-id');

  const setLogin = transport.actions.find((entry) => entry.action === 'set-login');
  assert.ok(setLogin);
  assert.equal(setLogin.payload.url, 'https://site.example.test');
  assert.equal(setLogin.payload.login, 'bob');
  assert.equal(setLogin.payload.password, 'kp-secret');
  assert.equal(setLogin.payload.group, 'Browser');

  const updated = await adapter.save({
    url: 'https://site.example.test',
    username: 'bob',
    password: 'rotated',
    uuid: 'kp-entry-id',
  });
  assert.equal(updated.created, false);
  const last = transport.actions.filter((entry) => entry.action === 'set-login').at(-1);
  assert.equal(last.payload.uuid, 'kp-entry-id');
  assert.equal(last.payload.password, 'rotated');
});
