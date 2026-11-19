/**
 * 双源合并策略 —— D-02 的代码落地。
 *
 * 决策：两库同域名命中时，按用户配置的优先级排序取用，默认不弹窗。
 * 合并器只负责"确定的排序 + 歧义标记"，是否提示用户由 UI 层决定（关注点分离）。
 *
 * 纯函数，无浏览器 API 依赖，便于单测（T-1 测试向量）。
 */

import type { BackendAdapter, BackendSource, CredentialItem, SearchQuery } from './types.js';

/** 用户可配置的来源优先级，靠前者优先 */
export type SourcePriority = readonly BackendSource[];

/** D-02 推荐默认：Bitwarden 优先，KeePassXC 次之 */
export const DEFAULT_SOURCE_PRIORITY: SourcePriority = ['bitwarden', 'keepassxc'] as const;

export interface MergeResult {
  /** 按优先级排序后的全部命中 */
  readonly items: readonly CredentialItem[];
  /**
   * 是否存在"同一 URL 被多个来源命中"的歧义。
   * true 时 UI 可决定是否展示来源切换提示；默认不弹窗（D-02）。
   */
  readonly ambiguous: boolean;
}

/**
 * 跨后端搜索并合并。
 *
 * 容错契约：
 *  - 单个后端未就绪 / 抛错 → 跳过该来源，不影响其他来源结果（A-容错）。
 *  - 后端返回的条目 source 与其声明不符 → 丢弃，防止来源伪造（S-6）。
 */
export async function searchAcrossBackends(
  adapters: readonly BackendAdapter[],
  query: SearchQuery,
  priority: SourcePriority = DEFAULT_SOURCE_PRIORITY,
): Promise<MergeResult> {
  const rank = new Map<BackendSource, number>(priority.map((source, index) => [source, index]));

  const buckets = await Promise.all(
    adapters.map(async (adapter) => {
      if (!adapter.isReady() || !adapter.capabilities.search) {
        return [] as CredentialItem[];
      }
      try {
        const found = await adapter.search(query);
        // S-6：丢弃 source 声明不符的条目，来源只能由适配器层写入
        return found.filter((item) => item.source === adapter.source);
      } catch {
        // 单后端失败不拖垮全局；日志由适配器内部负责（S-2 不打印凭证）
        return [] as CredentialItem[];
      }
    }),
  );

  const hitsBySource = new Map<BackendSource, number>();
  const flat = buckets.flat();

  for (const item of flat) {
    hitsBySource.set(item.source, (hitsBySource.get(item.source) ?? 0) + 1);
  }

  const items = [...flat].sort((a, b) => {
    const rankA = rank.get(a.source) ?? Number.MAX_SAFE_INTEGER;
    const rankB = rank.get(b.source) ?? Number.MAX_SAFE_INTEGER;
    return rankA - rankB;
  });

  const hitSources = [...hitsBySource.values()].filter((count) => count > 0).length;
  return { items, ambiguous: hitSources > 1 };
}
