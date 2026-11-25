/** 扩展内部消息协议。所有消息只在扩展进程间传递，不进入页面上下文（S-4）。 */
import type { FillField, FillPlan } from '../core/fill.js';
import type { SaveAction, SaveTarget } from '../core/save.js';
import type { SearchView } from '../core/suggest.js';
import type { BackendSource, CredentialDraft, SaveResult } from '../core/types.js';
import type { ErrorCode } from './errors.js';

export const MSG = {
  SEARCH: 'vaultix:search',
  /** 低层：把已解析好的填充计划交给内容脚本写入输入框（仅 background → content） */
  FILL: 'vaultix:fill',
  /** 统一填充服务：按「来源 + 条目 + 字段」填充（popup / content → background） */
  FILL_ITEM: 'vaultix:fill-item',
  COPY: 'vaultix:copy',
  /** 复制某条目的密码或验证码；UI 只报条目，不持有明文 */
  COPY_ITEM: 'vaultix:copy-item',
  STATUS: 'vaultix:status',
  UNLOCK: 'vaultix:unlock',
  LOCK: 'vaultix:lock',
  SET_DEFAULT_SOURCE: 'vaultix:set-default-source',
  ASSOCIATE: 'vaultix:associate',
  /** 页面内浮层取当前站点的候选（不含密码） */
  PAGE_SUGGESTIONS: 'vaultix:page-suggestions',
  /** 通行密钥：是否可用 / 注册 / 断言（密码学与存储由 KeePassXC 完成） */
  PASSKEY_AVAILABLE: 'vaultix:passkey-available',
  PASSKEY_REGISTER: 'vaultix:passkey-register',
  PASSKEY_GET: 'vaultix:passkey-get',
  SAVE_CANDIDATE: 'vaultix:save-candidate',
  PENDING_SAVE: 'vaultix:pending-save',
  SAVE_DECISION: 'vaultix:save-decision',
} as const;

export interface SearchMessage {
  readonly type: typeof MSG.SEARCH;
  readonly url: string;
}

export interface FillMessage {
  readonly type: typeof MSG.FILL;
  readonly plan: FillPlan;
}

/** 请求填充某条凭证；真实值由 background 取出，请求方不需要也不应该持有密码 */
export interface FillItemMessage {
  readonly type: typeof MSG.FILL_ITEM;
  readonly source: BackendSource;
  readonly id: string;
  readonly fields: readonly FillField[];
  /** 发起页面的地址（iframe 场景下是 frame 自身的地址） */
  readonly url: string;
  /** 填充的同时把验证码复制到剪贴板（沿用 S-5 的 30 秒自动清空） */
  readonly copyTotp: boolean;
}

export interface FillItemResponse {
  readonly ok: boolean;
  /** 实际写入的字段数 */
  readonly filled?: number;
  /**
   * 填充计划。只在请求方是内容脚本时返回——由它在自己的 frame 内写入；
   * popup 发起的填充由 background 直接下发给标签页，不回传明文。
   */
  readonly plan?: FillPlan;
  readonly code?: ErrorCode;
}

export interface CopyItemMessage {
  readonly type: typeof MSG.COPY_ITEM;
  readonly source: BackendSource;
  readonly id: string;
  readonly kind: 'password' | 'totp';
  readonly url: string;
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

/** 首页切换默认填充库：选中库优先，另一库兜底。 */
export interface SetDefaultSourceMessage {
  readonly type: typeof MSG.SET_DEFAULT_SOURCE;
  readonly source: BackendSource;
}

export interface AssociateMessage {
  readonly type: typeof MSG.ASSOCIATE;
}

export interface CopyMessage {
  readonly type: typeof MSG.COPY;
  readonly text: string;
  readonly ttlMs?: number;
}

export interface PageSuggestionsMessage {
  readonly type: typeof MSG.PAGE_SUGGESTIONS;
  readonly url: string;
}

/** 通行密钥可用性探测（页面主世界通过中继询问） */
export interface PasskeyAvailableMessage {
  readonly type: typeof MSG.PASSKEY_AVAILABLE;
}

/**
 * 通行密钥请求。options 是已序列化的 WebAuthn 选项（二进制已转 base64url）；
 * origin 不由发送方提供——后台一律用 sender.url 的 origin，避免伪造域名。
 */
export interface PasskeyOptionsMessage {
  readonly type: typeof MSG.PASSKEY_REGISTER | typeof MSG.PASSKEY_GET;
  readonly options: Record<string, unknown>;
}

export interface PasskeyResponse {
  readonly ok: boolean;
  /** 扩展不负责这次请求，交回浏览器原生实现 */
  readonly fallback?: boolean;
  /** 成功时是 KeePassXC 返回的 PublicKeyCredential JSON（base64 字符串） */
  readonly credential?: Record<string, unknown>;
  /** 失败时是 KeePassXC 的错误码 */
  readonly errorCode?: number;
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

/**
 * 用户对保存提示的决定：确认写入某个来源，或忽略（source = null）。
 * 草稿始终留在后台，确认时不需要也不应该把密码再传回来。
 */
export interface SaveDecisionMessage {
  readonly type: typeof MSG.SAVE_DECISION;
  readonly source: BackendSource | null;
}

export type RuntimeMessage =
  | SearchMessage
  | FillMessage
  | FillItemMessage
  | CopyItemMessage
  | StatusMessage
  | UnlockMessage
  | LockMessage
  | SetDefaultSourceMessage
  | AssociateMessage
  | CopyMessage
  | PageSuggestionsMessage
  | PasskeyAvailableMessage
  | PasskeyOptionsMessage
  | SaveCandidateMessage
  | PendingSaveMessage
  | SaveDecisionMessage;

export interface StatusResponse {
  /** Bitwarden 会话状态；KeePassXC 不受此状态约束（桌面端自行解锁） */
  readonly state: 'locked' | 'unlocked' | 'suspended';
  readonly bitwardenReady: boolean;
  readonly bitwardenConfigured: boolean;
  readonly keepassReady: boolean;
  readonly needsAssociation: boolean;
  readonly canWrite: boolean;
  /** 是否有任一后端可取用凭证 */
  readonly anyReady: boolean;
  /** 默认填充库（首页选择）：选中库优先，另一库兜底 */
  readonly defaultFillSource: BackendSource;
  /** 默认保存目标，来自设置页 */
  readonly defaultSaveSource: BackendSource;
}

export interface PageSuggestionsResponse extends SearchView {
  /** 设置页的「打开网页时自动填充」开关 */
  readonly autoFillOnLoad: boolean;
  /** 是否有任一后端可用（为 false 时浮层给出连接引导而不是「无匹配」） */
  readonly anyReady: boolean;
}

/** 保存候选的判定结果：新建 / 更新已有条目 / 无需处理 */
export interface SaveCheckResponse {
  readonly action: SaveAction;
  readonly target?: SaveTarget;
  readonly sources: readonly BackendSource[];
}

/** 后台暂存的保存草稿：判定结果 + 显示用的用户名与域名，不含密码 */
export interface PendingSaveResponse {
  readonly username: string;
  readonly host: string;
  readonly decision: SaveCheckResponse;
}

export type MessageResponse =
  | SearchView
  | StatusResponse
  | SaveResult
  | SaveCheckResponse
  | PendingSaveResponse
  | FillItemResponse
  | PageSuggestionsResponse
  | PasskeyResponse
  | { ok: boolean }
  | null;

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && Object.values(MSG).includes(type as never);
}
