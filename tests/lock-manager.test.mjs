/** T-4：锁定策略状态机，含 service worker 被回收场景。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOCK_POLICY,
  isLockSnapshot,
  LockManager,
} from '../.test-build/src/core/lock-manager.js';

function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    set: (value) => {
      now = value;
    },
  };
}

test('初始为锁定态，解锁后可填充', () => {
  const clock = fakeClock();
  const manager = new LockManager(DEFAULT_LOCK_POLICY, clock.now);
  assert.equal(manager.getState(), 'locked');
  assert.equal(manager.isUnlocked(), false);
  assert.equal(manager.handle('UNLOCK'), 'unlocked');
  assert.equal(manager.isUnlocked(), true);
});

test('service worker 回收后必须重新解锁，禁止静默恢复', () => {
  const clock = fakeClock();
  const manager = new LockManager(DEFAULT_LOCK_POLICY, clock.now);
  manager.handle('UNLOCK');
  assert.equal(manager.handle('SUSPEND'), 'suspended');
  assert.equal(manager.isUnlocked(), false);
  assert.equal(manager.handle('RESUME'), 'suspended');
  assert.equal(manager.isUnlocked(), false);
  assert.equal(manager.handle('UNLOCK'), 'unlocked');
});

test('后台超时自动锁定', () => {
  const clock = fakeClock();
  const policy = { backgroundLockMs: 1000, idleLockMs: 10_000 };
  const manager = new LockManager(policy, clock.now);
  manager.handle('UNLOCK');
  manager.enterBackground();
  clock.set(999);
  assert.equal(manager.tick(), 'unlocked');
  clock.set(1000);
  assert.equal(manager.tick(), 'locked');
});

test('空闲超时自动锁定，活动会重置计时', () => {
  const clock = fakeClock();
  const policy = { backgroundLockMs: 5000, idleLockMs: 1000 };
  const manager = new LockManager(policy, clock.now);
  manager.handle('UNLOCK');
  clock.set(900);
  manager.handle('ACTIVITY');
  clock.set(1899);
  assert.equal(manager.tick(), 'unlocked');
  clock.set(1900);
  assert.equal(manager.tick(), 'locked');
});

test('显式锁定立即生效', () => {
  const clock = fakeClock();
  const manager = new LockManager(DEFAULT_LOCK_POLICY, clock.now);
  manager.handle('UNLOCK');
  assert.equal(manager.handle('LOCK'), 'locked');
  assert.equal(manager.tick(), 'locked');
});

test('会话态可导出并在新实例上恢复，恢复后仍按剩余时间锁定', () => {
  const clock = fakeClock(1000);
  const policy = { backgroundLockMs: 500, idleLockMs: 1000 };
  const first = new LockManager(policy, clock.now);
  first.handle('UNLOCK');
  const snapshot = first.snapshot();
  assert.deepEqual(snapshot, { state: 'unlocked', lastActivity: 1000, backgroundSince: null });

  // 模拟 service worker 被回收后重建：新实例从会话态恢复，计时不清零
  const second = new LockManager(policy, clock.now);
  second.restore(snapshot);
  clock.set(1900);
  assert.equal(second.tick(), 'unlocked');
  clock.set(2000);
  assert.equal(second.tick(), 'locked');
});

test('后台计时同样随会话态恢复：切走 5 分钟后回来即锁定', () => {
  const clock = fakeClock(0);
  const policy = { backgroundLockMs: 1000, idleLockMs: 60_000 };
  const first = new LockManager(policy, clock.now);
  first.handle('UNLOCK');
  first.enterBackground();
  clock.set(200);

  const second = new LockManager(policy, clock.now);
  second.restore(first.snapshot());
  clock.set(999);
  assert.equal(second.tick(), 'unlocked');
  clock.set(1000);
  assert.equal(second.tick(), 'locked');
});

test('isLockSnapshot 拒绝畸形数据', () => {
  assert.equal(isLockSnapshot(null), false);
  assert.equal(isLockSnapshot({}), false);
  assert.equal(isLockSnapshot({ state: 'open', lastActivity: 0, backgroundSince: null }), false);
  assert.equal(
    isLockSnapshot({ state: 'unlocked', lastActivity: 'now', backgroundSince: null }),
    false,
  );
  assert.equal(isLockSnapshot({ state: 'unlocked', lastActivity: 0, backgroundSince: 'x' }), false);
  assert.equal(isLockSnapshot({ state: 'unlocked', lastActivity: 0, backgroundSince: null }), true);
  assert.equal(isLockSnapshot({ state: 'locked', lastActivity: 0, backgroundSince: 5 }), true);
});
