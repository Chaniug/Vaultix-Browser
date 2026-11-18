/** 扩展内部消息协议。所有消息只在扩展进程间传递，不进入页面上下文（S-4）。 */
import type { MergeResult } from '../core/merger.js';
import type { BackendSource, CredentialDraft, SaveResult, SearchQuery } from '../core/types.js';

export const MSG = {
  SEARCH: 'vaultix:search',
  FILL: 'vaultix:fill',
  STATUS: 'vaultix:status',
  UNLOCK: 'vaultix:unlock',
  LOCK: 'vaultix:lock',
  ASSOCIATE: 'vaultix:associate',
  COPY: 'vaultix:copy',
  FIELDS_CHANGED: 'vaultix:fields-changed',
  SAVE_CANDIDATE: 'vaultix:save-candidate',
  PENDING_SAVE: 'vaultix:pending-save',
  SAVE_DECISION: 'vaultix:save-decision',
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

/** content 检测到表单提交后上报的保存候选（明文仅在扩展进程内存流转，S-1/S-4） */
export interface SaveCandidateMessage {
  readonly type: typeof MSG.SAVE_CANDIDATE;
  readonly draft: CredentialDraft;
}

/** popup 拉取当前待确认的保存候选 */
export interface PendingSaveMessage {
  readonly type: typeof MSG.PENDING_SAVE;
}

/** popup 用户决策：确认写入某后端，或取消 */
export interface SaveDecisionMessage {
  readonly type: typeof MSG.SAVE_DECISION;
  readonly draft: CredentialDraft;
  readonly source: BackendSource | null;
}

export type RuntimeMessage =
  | SearchMessage
  | FillMessage
  | StatusMessage
  | UnlockMessage
  | LockMessage
  | AssociateMessage
  | CopyMessage
  | FieldsChangedMessage
  | SaveCandidateMessage
  | PendingSaveMessage
  | SaveDecisionMessage;

export interface StatusResponse {
  readonly state: 'locked' | 'unlocked' | 'suspended';
  readonly bitwardenReady: boolean;
  readonly keepassReady: boolean;
  readonly needsAssociation: boolean;
  readonly canWrite: boolean;
  /** 默认保存目标，来自设置页 */
  readonly defaultSaveSource: BackendSource;
}

export interface PendingSaveResponse {
  readonly draft: CredentialDraft | null;
  readonly sources: readonly BackendSource[];
}

export type MessageResponse =
  MergeResult | StatusResponse | SaveResult | PendingSaveResponse | { ok: boolean } | null;

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && Object.values(MSG).includes(type as never);
}
