/**
 * 锁定策略状态机（M-6 / T-4）。
 *
 * MV3 service worker 空闲会被浏览器终止，因此"被回收"是独立状态：
 * 回收后一律要求重新解锁，禁止静默降级为明文缓存或续用旧会话。
 * 本模块不依赖浏览器 API，便于状态机单测。
 */

export type LockState = 'locked' | 'unlocked' | 'suspended';
export type LockEvent = 'UNLOCK' | 'LOCK' | 'SUSPEND' | 'RESUME' | 'ACTIVITY';

export interface LockPolicy {
  /** 进入后台多久后锁定，默认 5 分钟 */
  readonly backgroundLockMs: number;
  /** 无操作多久后锁定，默认 15 分钟 */
  readonly idleLockMs: number;
}

export const DEFAULT_LOCK_POLICY: LockPolicy = {
  backgroundLockMs: 5 * 60 * 1000,
  idleLockMs: 15 * 60 * 1000,
};

/**
 * 可持久化的会话态。只允许写入 chrome.storage.session（内存态，不落盘，S-1），
 * 用于 service worker 被回收后恢复计时，避免"回收即重置超时"让策略形同虚设。
 */
export interface LockSnapshot {
  readonly state: LockState;
  readonly lastActivity: number;
  readonly backgroundSince: number | null;
}

export function isLockSnapshot(value: unknown): value is LockSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const state = candidate.state;
  if (state !== 'locked' && state !== 'unlocked' && state !== 'suspended') return false;
  if (typeof candidate.lastActivity !== 'number') return false;
  return candidate.backgroundSince === null || typeof candidate.backgroundSince === 'number';
}

export class LockManager {
  private state: LockState = 'locked';
  private lastActivity = 0;
  private backgroundSince: number | null = null;

  constructor(
    private readonly policy: LockPolicy = DEFAULT_LOCK_POLICY,
    private readonly now: () => number = () => Date.now(),
  ) {}

  getState(): LockState {
    return this.state;
  }

  isUnlocked(): boolean {
    return this.state === 'unlocked';
  }

  /** 处理离散事件；返回新状态 */
  handle(event: LockEvent): LockState {
    const at = this.now();
    switch (event) {
      case 'UNLOCK':
        this.state = 'unlocked';
        this.lastActivity = at;
        this.backgroundSince = null;
        break;
      case 'LOCK':
        this.state = 'locked';
        this.backgroundSince = null;
        break;
      case 'SUSPEND':
        // service worker 被回收：密钥随之消失，只能重新解锁
        this.state = 'suspended';
        this.backgroundSince = null;
        break;
      case 'RESUME':
        // 恢复不等于解锁：保持 suspended，等待 UNLOCK
        if (this.state === 'suspended') break;
        this.backgroundSince = null;
        break;
      case 'ACTIVITY':
        if (this.state === 'unlocked') this.lastActivity = at;
        break;
    }
    return this.state;
  }

  /** 进入后台（例如浏览器窗口失焦） */
  enterBackground(): void {
    if (this.state === 'unlocked') this.backgroundSince = this.now();
  }

  /** 定时检查；返回最新状态 */
  tick(): LockState {
    if (this.state !== 'unlocked') return this.state;
    const at = this.now();
    if (
      this.backgroundSince !== null &&
      at - this.backgroundSince >= this.policy.backgroundLockMs
    ) {
      return this.handle('LOCK');
    }
    if (at - this.lastActivity >= this.policy.idleLockMs) {
      return this.handle('LOCK');
    }
    return this.state;
  }

  /** 导出会话态：调用方负责写 chrome.storage.session（S-1） */
  snapshot(): LockSnapshot {
    return {
      state: this.state,
      lastActivity: this.lastActivity,
      backgroundSince: this.backgroundSince,
    };
  }

  /** 从会话态恢复：仅在 service worker 重启后调用，恢复后仍按剩余时间判定超时 */
  restore(snapshot: LockSnapshot): void {
    this.state = snapshot.state;
    this.lastActivity = snapshot.lastActivity;
    this.backgroundSince = snapshot.backgroundSince;
  }
}
