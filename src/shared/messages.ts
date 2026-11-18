/** 扩展内部消息协议。所有消息只在扩展进程间传递，不进入页面上下文（S-4）。 */
import type { MergeResult } from '../core/merger.js';
import type { SearchQuery } from '../core/types.js';

export const MSG = {
  SEARCH: 'vaultix:search',
  FILL: 'vaultix:fill',
  STATUS: 'vaultix:status',
  UNLOCK: 'vaultix:unlock',
  LOCK: 'vaultix:lock',
  ASSOCIATE: 'vaultix:associate',
  COPY: 'vaultix:copy',
  FIELDS_CHANGED: 'vaultix:fields-changed',
} as const;

export interface SearchMessage {
  readonly type: typeof MSG.SEARCH;
  readonly query: SearchQuery;
}

export interface FillMessage {
  readonly type: typeof MSG.FILL;
  readonly plan: {
    readonly username?: string;
    readonly password?: string;
    readonly totp?: string;
  };
}

export interface StatusMessage {
  readonly type: typeof MSG.STATUS;
}

export interface UnlockMessage {
  readonly type: typeof MSG.UNLOCK;
  readonly masterPassword?: string;
  readonly twoFactorCode?: string;
}

export interface LockMessage {
  readonly type: typeof MSG.LOCK;
}

export interface AssociateMessage {
  readonly type: typeof MSG.ASSOCIATE;
}

export interface CopyMessage {
  readonly type: typeof MSG.COPY;
  readonly text: string;
  readonly ttlMs?: number;
}

export interface FieldsChangedMessage {
  readonly type: typeof MSG.FIELDS_CHANGED;
  readonly fields: readonly string[];
}

export type RuntimeMessage =
  | SearchMessage
  | FillMessage
  | StatusMessage
  | UnlockMessage
  | LockMessage
  | AssociateMessage
  | CopyMessage
  | FieldsChangedMessage;

export interface StatusResponse {
  readonly state: 'locked' | 'unlocked' | 'suspended';
  readonly bitwardenReady: boolean;
  readonly keepassReady: boolean;
  readonly needsAssociation: boolean;
}

export type MessageResponse = MergeResult | StatusResponse | { ok: boolean } | null;

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && Object.values(MSG).includes(type as never);
}
