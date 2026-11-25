/**
 * T-1/T-2：Bitwarden 加密链与 Client API 测试向量。
 * 用 Node 标准库独立实现加密侧，验证 WebCrypto 解密侧；覆盖官方云 / Vaultwarden 两种端点配置。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import {
  BitwardenClient,
  createBitwardenAdapter,
  resolveEndpoints,
} from '../.test-build/src/adapters/bitwarden/index.js';
import {
  deriveMasterKey,
  hashMasterPassword,
  stretchMasterKey,
  decryptCipherString,
} from '../.test-build/src/adapters/bitwarden/crypto.js';
import { base64ToBytes } from '../.test-build/src/shared/encoding.js';

const EMAIL = 'alice@example.com';
const PASSWORD = 'correct horse battery staple';
const ITERATIONS = 1000;
const SYMMETRIC_KEY = nodeCrypto.randomBytes(64);
const MASTER_KEY = await deriveMasterKey(EMAIL, PASSWORD, ITERATIONS);

/** Bitwarden HKDF-Expand：以 masterKey 为 PRK，info 为 'enc' / 'mac'，单步 HMAC-SHA256。 */
function hkdfExpand(prk, info) {
  return nodeCrypto
    .createHmac('sha256', prk)
    .update(Buffer.concat([Buffer.from(info, 'utf8'), Buffer.from([0x01])]))
    .digest();
}

function stretched(masterKey) {
  return Buffer.concat([hkdfExpand(masterKey, 'enc'), hkdfExpand(masterKey, 'mac')]);
}

function encString(text, key = SYMMETRIC_KEY) {
  const iv = nodeCrypto.randomBytes(16);
  const cipher = nodeCrypto.createCipheriv('aes-256-cbc', key.subarray(0, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const mac = nodeCrypto
    .createHmac('sha256', key.subarray(32, 64))
    .update(Buffer.concat([iv, ciphertext]))
    .digest();
  return `2.${iv.toString('base64')}|${ciphertext.toString('base64')}|${mac.toString('base64')}`;
}

function protectedKey(masterKey, symmetricKey) {
  const key = stretched(masterKey);
  const iv = nodeCrypto.randomBytes(16);
  const cipher = nodeCrypto.createCipheriv('aes-256-cbc', key.subarray(0, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(symmetricKey), cipher.final()]);
  const mac = nodeCrypto
    .createHmac('sha256', key.subarray(32, 64))
    .update(Buffer.concat([iv, ciphertext]))
    .digest();
  return `2.${iv.toString('base64')}|${ciphertext.toString('base64')}|${mac.toString('base64')}`;
}

function installFetchStub() {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    seen.push({ url, init });
    let body = {};
    if (url.includes('/api/accounts/prelogin')) {
      body = { kdf: 0, kdfIterations: ITERATIONS };
    } else if (url.includes('/connect/token')) {
      body = {
        access_token: 'test-access-token',
        expires_in: 3600,
        token_type: 'Bearer',
      };
    } else if (url.includes('/api/sync')) {
      body = {
        profile: { key: protectedKey(MASTER_KEY, SYMMETRIC_KEY) },
        ciphers: [
          {
            id: 'cipher-1',
            name: encString('Work Mail'),
            login: {
              username: encString('alice'),
              password: encString('p@ssw0rd'),
              totp: encString('123456'),
              uris: [
                {
                  uri: encString('https://mail.example.com'),
                  match: 0,
                },
              ],
            },
            fields: [
              {
                name: encString('Recovery'),
                value: encString('recovery-code'),
                type: 1,
              },
            ],
            notes: encString('primary account'),
          },
          {
            id: 'cipher-2',
            name: encString('Other Site'),
            login: {
              username: encString('bob'),
              password: encString('other-pass'),
              uris: [{ uri: encString('https://other.example.org'), match: 1 }],
            },
          },
        ],
      };
    } else {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return {
    seen,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test('PBKDF2 向量与 Node 标准库一致', async () => {
  const expectedMaster = nodeCrypto.pbkdf2Sync(
    PASSWORD,
    EMAIL.toLowerCase(),
    ITERATIONS,
    32,
    'sha256',
  );
  const master = await deriveMasterKey(EMAIL, PASSWORD, ITERATIONS);
  assert.deepEqual([...master], [...expectedMaster]);

  // 拉伸密钥 = HKDF-Expand(masterKey,'enc') || HKDF-Expand(masterKey,'mac')
  const expectedStretched = stretched(expectedMaster);
  const actualStretched = await stretchMasterKey(master);
  assert.deepEqual([...actualStretched], [...expectedStretched]);

  // 认证哈希 = 单轮 PBKDF2(masterKey, 主密码)
  const expectedHash = nodeCrypto
    .pbkdf2Sync(expectedMaster, Buffer.from(PASSWORD, 'utf8'), 1, 32, 'sha256')
    .toString('base64');
  assert.equal(await hashMasterPassword(master, PASSWORD), expectedHash);
});

test('AES-256-CBC + HMAC 字段解密与篡改检测', async () => {
  const plain = 'vaultix-测试';
  const encrypted = encString(plain);
  assert.equal(await decryptCipherString(encrypted, SYMMETRIC_KEY), plain);

  const parts = encrypted.slice(2).split('|');
  const mac = base64ToBytes(parts[2]);
  mac[0] ^= 0xff;
  parts[2] = Buffer.from(mac).toString('base64');
  await assert.rejects(
    () => decryptCipherString(`2.${parts.join('|')}`, SYMMETRIC_KEY),
    (error) => error.code === 'DECRYPT_FAILED',
  );
});

test('登录 → sync → 解密 → URI 匹配（Vaultwarden 配置）', async () => {
  const stub = installFetchStub();
  try {
    const adapter = createBitwardenAdapter({
      serverUrl: 'https://vault.example.test',
      mode: 'vaultwarden',
      email: EMAIL,
      masterPassword: PASSWORD,
      kdfIterations: ITERATIONS,
    });
    assert.equal(adapter.isReady(), false);
    await adapter.login();
    assert.equal(adapter.isReady(), true);

    const items = await adapter.search({
      url: 'https://mail.example.com/login',
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].source, 'bitwarden');
    assert.equal(items[0].name, 'Work Mail');
    assert.equal(items[0].username, 'alice');
    assert.equal(items[0].password, 'p@ssw0rd');
    assert.equal(items[0].totp, '123456');
    assert.equal(items[0].notes, 'primary account');
    assert.equal(items[0].customFields?.[0]?.name, 'Recovery');
    assert.equal(items[0].customFields?.[0]?.type, 'hidden');

    const snapshot = adapter.exportSession();
    assert.ok(snapshot);
    assert.equal(snapshot.accessToken, 'test-access-token');
    assert.equal(base64ToBytes(snapshot.symmetricKey).length, 64);

    const tokenCall = stub.seen.find((entry) => entry.url.includes('/connect/token'));
    const form = new URLSearchParams(tokenCall.init.body);
    assert.equal(form.get('grant_type'), 'password');
    assert.equal(form.get('username'), EMAIL);
    assert.equal(
      form.get('password'),
      nodeCrypto
        .pbkdf2Sync(MASTER_KEY, Buffer.from(PASSWORD, 'utf8'), 1, 32, 'sha256')
        .toString('base64'),
    );

    const syncCall = stub.seen.find((entry) => entry.url.includes('/api/sync'));
    assert.equal(syncCall.url, 'https://vault.example.test/api/sync?excludeDomains=true');
    assert.equal(syncCall.init.headers.Authorization, 'Bearer test-access-token');
  } finally {
    stub.restore();
  }
});

test('TOTP 登录请求使用官方字段名 twoFactorToken / twoFactorProvider', async () => {
  const stub = installFetchStub();
  try {
    const client = new BitwardenClient('https://vault.example.test', 'vaultwarden');
    await client.loginWithPassword(EMAIL, 'auth-hash', '123456');
    const call = stub.seen.find((entry) => entry.url.includes('/connect/token'));
    const form = new URLSearchParams(call.init.body);
    assert.equal(form.get('twoFactorToken'), '123456');
    assert.equal(form.get('twoFactorProvider'), '0');
    assert.equal(form.get('twoFactorRemember'), '0');
    assert.equal(form.has('twoFactorCode'), false);
    assert.equal(form.has('twoFactorMethod'), false);
  } finally {
    stub.restore();
  }
});

test('官方云 / Vaultwarden 端点配置在同一套代码下切换', () => {
  assert.deepEqual(resolveEndpoints('https://vault.bitwarden.com', 'bitwarden.cloud'), {
    apiBase: 'https://api.bitwarden.com',
    identityBase: 'https://identity.bitwarden.com',
    origin: 'https://vault.bitwarden.com',
  });
  assert.deepEqual(resolveEndpoints('https://vault.example.test', 'vaultwarden'), {
    apiBase: 'https://vault.example.test',
    identityBase: 'https://vault.example.test/identity',
    origin: 'https://vault.example.test',
  });
  assert.throws(
    () => resolveEndpoints('http://vault.example.test', 'vaultwarden'),
    (error) => error.code === 'PERMISSION_DENIED',
  );
});

test('会话快照可恢复为就绪适配器（密钥仅内存态）', async () => {
  const stub = installFetchStub();
  try {
    const symmetricKey = Buffer.from(SYMMETRIC_KEY).toString('base64');
    const adapter = createBitwardenAdapter({
      serverUrl: 'https://vault.example.test',
      mode: 'vaultwarden',
      accessToken: 'test-access-token',
      symmetricKey,
    });
    assert.equal(adapter.isReady(), true);
    const items = await adapter.listAll();
    assert.equal(items.length, 2);
  } finally {
    stub.restore();
  }
});
