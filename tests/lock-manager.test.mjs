/** T-4：锁定策略状态机，含 service worker 被回收场景。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOCK_POLICY, LockManager } from '../.test-build/src/core/lock-manager.js';

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
