/**
 * T-1 测试向量：验证 P0 合并策略的关键行为。
 * 用 Node 内置 test runner，不引入外部依赖。
 *
 * 运行：npm run test:core（脚本会先编译 TS 到 .test-build）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchAcrossBackends } from '../.test-build/src/core/merger.js';

/** 构造一个满足 BackendAdapter 契约的测试替身 */
function makeAdapter(source, items, { ready = true, throws = false } = {}) {
  return {
    source,
    capabilities: {
      search: true,
      listAll: false,
      totp: false,
      customFields: false,
      uriMatching: false,
      write: false,
    },
    isReady: () => ready,
    search: async () => {
      if (throws) throw new Error('simulated backend failure');
      return items;
    },
    listAll: async () => [],
  };
}

function item(source, id) {
  return { id, source, name: id, username: 'user', password: 'secret' };
}

test('优先级排序：bitwarden 默认排在 keepassxc 之前', async () => {
  const bw = makeAdapter('bitwarden', [item('bitwarden', 'bw-1')]);
  const kp = makeAdapter('keepassxc', [item('keepassxc', 'kp-1')]);
  const { items, ambiguous } = await searchAcrossBackends(
    [kp, bw],
    { url: 'https://example.com' },
  );
  assert.deepEqual(items.map((i) => i.source), ['bitwarden', 'keepassxc']);
  assert.equal(ambiguous, true, '双源命中应标记歧义');
});

test('单源命中不标记歧义', async () => {
  const bw = makeAdapter('bitwarden', [item('bitwarden', 'bw-1')]);
  const { items, ambiguous } = await searchAcrossBackends(
    [bw],
    { url: 'https://example.com' },
  );
  assert.equal(items.length, 1);
  assert.equal(ambiguous, false);
});

test('S-6 防伪造：丢弃 source 与适配器声明不符的条目', async () => {
  const bw = makeAdapter('bitwarden', [item('keepassxc', 'forged')]);
  const { items } = await searchAcrossBackends(
    [bw],
    { url: 'https://example.com' },
  );
  assert.equal(items.length, 0, '伪造来源的条目必须被丢弃');
});

test('容错：单后端抛错时不拖垮其他来源', async () => {
  const broken = makeAdapter('bitwarden', [], { throws: true });
  const kp = makeAdapter('keepassxc', [item('keepassxc', 'kp-1')]);
  const { items, ambiguous } = await searchAcrossBackends(
    [broken, kp],
    { url: 'https://example.com' },
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'keepassxc');
  assert.equal(ambiguous, false);
});

test('未就绪的后端被跳过', async () => {
  const locked = makeAdapter('bitwarden', [item('bitwarden', 'bw-1')], {
    ready: false,
  });
  const kp = makeAdapter('keepassxc', [item('keepassxc', 'kp-1')]);
  const { items } = await searchAcrossBackends(
    [locked, kp],
    { url: 'https://example.com' },
  );
  assert.deepEqual(items.map((i) => i.source), ['keepassxc']);
});
