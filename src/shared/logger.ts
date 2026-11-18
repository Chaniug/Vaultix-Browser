/**
 * 统一日志封装（S-2）。
 * 规则：只允许结构化白名单字段；域名先经 redactDomain；凭证 / token / 完整 URL 一律不接收。
 * 生产构建可通过 setLogSink 替换为静默实现。
 */
import type { ErrorCode } from './errors.js';
import { redactDomain } from './url.js';

export interface LogFields {
  readonly backend?: 'bitwarden' | 'keepassxc';
  readonly code?: ErrorCode;
  readonly ok?: boolean;
  readonly durationMs?: number;
  /** 传入 URL 或域名，内部只保留 eTLD+1 */
  readonly domain?: string;
}

type Sink = (level: 'debug' | 'warn', event: string, fields: LogFields) => void;

let sink: Sink = (level, event, fields) => {
  // console 只允许在此出现；字段已白名单化，不含用户数据
  const safe: Record<string, unknown> = {};
  if (fields.backend) safe.backend = fields.backend;
  if (fields.code) safe.code = fields.code;
  if (typeof fields.ok === 'boolean') safe.ok = fields.ok;
  if (typeof fields.durationMs === 'number') {
    safe.durationMs = Math.round(fields.durationMs);
  }
  if (fields.domain) safe.domain = redactDomain(fields.domain);
  // eslint-disable-next-line no-console
  (level === 'warn' ? console.warn : console.debug)('[vaultix]', event, safe);
};

export function setLogSink(next: Sink): void {
  sink = next;
}

export function logDebug(event: string, fields: LogFields = {}): void {
  sink('debug', event, fields);
}

export function logWarn(event: string, fields: LogFields = {}): void {
  sink('warn', event, fields);
}
