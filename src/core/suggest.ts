/**
 * 候选瘦身：把内部 CredentialItem 收敛成给 UI / 内容脚本看的 Suggestion。
 *
 * 目的（S-1 / 最小暴露）：搜索结果不再携带明文密码。popup 与页面内浮层只需要
 * 「显示什么」和「点谁」，真正的密码只在用户确认填充的那一刻由统一填充服务取用。
 * source 仍由适配器写入、此处原样透传，UI 只读（S-6）。
 */
import type { BackendSource, CredentialItem } from './types.js';

export interface Suggestion {
  readonly id: string;
  readonly source: BackendSource;
  readonly name: string;
  readonly username: string;
  /** 条目带验证码种子或即时码 */
  readonly hasTotp: boolean;
}

export interface SearchView {
  readonly items: readonly Suggestion[];
  /** 多个来源同时命中（D-02：只提示，不阻塞） */
  readonly ambiguous: boolean;
}

export function toSuggestion(item: CredentialItem): Suggestion {
  return {
    id: item.id,
    source: item.source,
    name: item.name,
    username: item.username,
    hasTotp: item.totp !== undefined && item.totp.length > 0,
  };
}

export function toSearchView(items: readonly CredentialItem[]): SearchView {
  const sources = new Set(items.map((item) => item.source));
  return { items: items.map(toSuggestion), ambiguous: sources.size > 1 };
}
