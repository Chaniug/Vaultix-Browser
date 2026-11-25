/**
 * T-1 KeePassRPC 协议测试向量：用内存中的模拟 KeePassXC 服务端完成真实 NaCl 加解密往返。
 * 覆盖握手、配对、get-logins、get-totp、nonce 校验与错误码容错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { createKeePassRpcAdapter } from '../.test-build/src/adapters/keepassrpc/index.js';
import {
  base64ToBytes,
  bytesToBase64,
  incrementNonce,
  utf8ToBytes,
  bytesToUtf8,
} from '../.test-build/src/shared/encoding.js';

const HOST_KEY = nacl.box.keyPair();
const CLIENT_ID = bytesToBase64(nacl.randomBytes(24));

class MockNativeTransport {
  constructor({ nonceMismatch = false, noMatch = false, version = '2.8.0' } = {}) {
    this.connected = false;
    this.clientPublicKey = null;
    this.nonceMismatch = nonceMismatch;
    this.noMatch = noMatch;
    this.version = version;
    this.actions = [];
    this.requests = [];
    /** 设为非空时，通行密钥请求返回未加密的外层错误（实测 2.8.0 的形态） */
    this.passkeyOuterError = null;
  }

  async connect() {
    this.connected = true;
  }

  disconnect() {
    this.connected = false;
  }

  async send(message) {
    const action = message.action;
    if (this.passkeyOuterError !== null && action.startsWith('passkeys-')) {
      return { action, ...this.passkeyOuterError };
    }
    if (action === 'change-public-keys') {
      this.clientPublicKey = base64ToBytes(message.publicKey);
      return {
        action,
        publicKey: bytesToBase64(HOST_KEY.publicKey),
        success: 'true',
        nonce: message.nonce,
        clientID: message.clientID,
        version: this.version,
      };
    }

    const nonce = base64ToBytes(message.nonce);
    const opened = nacl.box.open(
      base64ToBytes(message.message),
      nonce,
      this.clientPublicKey,
      HOST_KEY.secretKey,
    );
    assert.ok(opened, '请求必须能被 host 私钥解开');
    const request = JSON.parse(bytesToUtf8(opened));
    this.actions.push(request.action);
    this.requests.push(request);

    let payload;
    if (request.action === 'get-logins') {
      payload = this.noMatch
        ? { success: 'false', errorCode: 15, error: 'no logins found' }
        : {
            success: 'true',
            count: '2',
            entries: [
              {
                uuid: 'entry-uuid-1',
                name: 'Work Mail',
                login: 'alice',
                password: 's3cret',
                expired: 'false',
              },
              {
                uuid: 'entry-uuid-2',
                name: 'Old Mail',
                login: 'bob',
                password: 'old-pass',
                expired: 'true',
                totp: '111111',
              },
            ],
            hash: 'aabbccdd',
            version: '2.7.10',
          };
    } else if (request.action === 'get-totp') {
      payload = { success: 'true', totp: '654321', version: '2.7.10' };
    } else if (request.action === 'associate') {
      payload = { success: 'true', id: 'vaultix-client', hash: 'aabbccdd' };
    } else if (request.action === 'test-associate') {
      payload = { success: 'true', id: request.id, hash: 'aabbccdd' };
    } else if (request.action === 'passkeys-get' || request.action === 'passkeys-register') {
      // KeePassXC 把结果放在 response 里；没有可用凭据时是 { errorCode }
      payload = { success: 'true', response: { errorCode: 15 } };
    } else {
      payload = { success: 'false', errorCode: 42 };
    }

    // 真实 KeePassXC：服务端另生成一个响应 nonce，并用它加密 message；
    // 客户端必须用响应 nonce 开箱。请求 nonce 只用于客户端封箱。
    const responseNonce = nacl.randomBytes(24);
    const nonceShadow = this.nonceMismatch ? incrementNonce(responseNonce) : responseNonce;
    const encrypted = nacl.box(
      utf8ToBytes(JSON.stringify(payload)),
      responseNonce,
      this.clientPublicKey,
      HOST_KEY.secretKey,
    );
    return {
      action: request.action,
      message: bytesToBase64(encrypted),
      nonce: bytesToBase64(nonceShadow),
      clientID: message.clientID,
      success: 'true',
    };
  }
}

test('握手 → 配对 → get-logins → get-totp 全链路', async () => {
  const transport = new MockNativeTransport();
  const adapter = createKeePassRpcAdapter({ clientId: CLIENT_ID }, transport);
  assert.equal(adapter.isReady(), false);

  const association = await adapter.associate();
  assert.deepEqual(association, {
    id: 'vaultix-client',
    key: association.key,
  });
  assert.equal(typeof association.key, 'string');
  assert.equal(adapter.isReady(), true);

  const items = await adapter.search({
    url: 'https://mail.example.com/login',
    submitUrl: 'https://mail.example.com/session',
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].source, 'keepassxc');
  assert.equal(items[0].username, 'alice');
  assert.equal(items[0].password, 's3cret');
  assert.equal(items[0].totp, '654321', '缺少 TOTP 时应调用 get-totp 补齐');
  assert.equal(items[0].expired, false);
  assert.equal(items[1].totp, '111111', '条目自带 TOTP 时不应覆盖');
  assert.equal(items[1].expired, true);
  assert.equal(items[0].meta.version, '2.7.10');
  assert.deepEqual(transport.actions, ['associate', 'get-logins', 'get-totp']);
});

test('已配对信息可在新会话中通过 test-associate 恢复', async () => {
  const firstTransport = new MockNativeTransport();
  const first = createKeePassRpcAdapter({ clientId: CLIENT_ID }, firstTransport);
  const association = await first.associate();

  const secondTransport = new MockNativeTransport();
  const second = createKeePassRpcAdapter({ clientId: CLIENT_ID, association }, secondTransport);
  await second.initialize();
  assert.equal(second.isReady(), true);
  assert.deepEqual(secondTransport.actions, ['test-associate']);
});

test('nonce 不符时 search 返回空数组而不抛异常（协议容错）', async () => {
  const transport = new MockNativeTransport();
  const adapter = createKeePassRpcAdapter({ clientId: CLIENT_ID }, transport);
  await adapter.associate();
  transport.nonceMismatch = true;
  const items = await adapter.search({ url: 'https://example.com' });
  assert.deepEqual(items, []);
});

test('错误码 15（无匹配）被当作空结果', async () => {
  const transport = new MockNativeTransport({ noMatch: true });
  const adapter = createKeePassRpcAdapter({ clientId: CLIENT_ID }, transport);
  await adapter.associate();
  const items = await adapter.search({ url: 'https://example.com' });
  assert.deepEqual(items, []);
});

test('NaCl 封箱测试向量：固定密钥 / nonce 得到确定密文', () => {
  const alice = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(1));
  const bob = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(2));
  const nonce = new Uint8Array(24).fill(3);
  const boxed = nacl.box(utf8ToBytes('vaultix'), nonce, bob.publicKey, alice.secretKey);
  const opened = nacl.box.open(boxed, nonce, alice.publicKey, bob.secretKey);
  assert.equal(bytesToUtf8(opened), 'vaultix');
  assert.equal(bytesToBase64(boxed).length > 0, true);
});

test('通行密钥：请求走加密通道，内层字段符合 KeePassXC 协议', async () => {
  const transport = new MockNativeTransport();
  const adapter = createKeePassRpcAdapter({ clientId: CLIENT_ID }, transport);
  const association = await adapter.associate();
  assert.equal(adapter.supportsPasskeys(), true);

  const options = { challenge: 'A'.repeat(43), rpId: 'example.com' };
  const payload = await adapter.passkeysGet(options, 'https://example.com');
  assert.deepEqual(payload, { errorCode: 15 });

  const inner = transport.requests.at(-1);
  assert.equal(inner.action, 'passkeys-get');
  assert.deepEqual(inner.publicKey, options);
  assert.equal(inner.origin, 'https://example.com');
  assert.deepEqual(inner.keys, [{ id: association.id, key: association.key }]);
  assert.deepEqual(inner.relatedOrigins, []);

  await adapter.passkeysRegister(
    { challenge: 'B'.repeat(16), user: { id: 'dXNlcg' } },
    'https://example.com',
  );
  assert.equal(transport.requests.at(-1).action, 'passkeys-register');
});

test('通行密钥：KeePassXC 低于 2.7.7 时视为不可用', async () => {
  const transport = new MockNativeTransport({ version: '2.7.6' });
  const adapter = createKeePassRpcAdapter({ clientId: CLIENT_ID }, transport);
  await adapter.associate();
  assert.equal(adapter.supportsPasskeys(), false);
});

test('通行密钥：未配对时直接拒绝，不发请求', async () => {
  const transport = new MockNativeTransport();
  const adapter = createKeePassRpcAdapter({ clientId: CLIENT_ID }, transport);
  await assert.rejects(() => adapter.passkeysGet({}, 'https://example.com'));
  assert.deepEqual(transport.requests, []);
});

test('通行密钥：未加密的外层错误码会被保留（实测 KeePassXC 2.8.0 的返回形态）', async () => {
  const transport = new MockNativeTransport();
  const adapter = createKeePassRpcAdapter({ clientId: CLIENT_ID }, transport);
  await adapter.associate();
  transport.passkeyOuterError = { error: '空的公钥', errorCode: '24' };
  const payload = await adapter.passkeysGet({}, 'https://example.com');
  assert.deepEqual(payload, { errorCode: 24 });
});
