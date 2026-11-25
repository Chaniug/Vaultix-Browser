/**
 * 保存判定：用户提交了一个账号密码后，判断该「新建」还是「更新」，还是什么都不用做。
 *
 * 只做纯计算，不接触适配器。比较需要明文密码，因此本函数只在 background 中调用，
 * 判定结果里不回传任何密码。
 */
import type { BackendSource, CredentialDraft, CredentialItem } from './types.js';

export interface SaveTarget {
  readonly source: BackendSource;
  readonly id: string;
  readonly name: string;
  readonly username: string;
}

export type SaveAction = 'none' | 'create' | 'update';

export interface SaveDecision {
  readonly action: SaveAction;
  /** action = update 时要更新的那条条目 */
  readonly target?: SaveTarget;
  /** 当前可以执行这次写入的来源（已就绪且具备写能力） */
  readonly sources: readonly BackendSource[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 判定规则：
 *  1. 没有可写来源 → none；
 *  2. 同站已有「同用户名 + 同密码」的条目 → none（正常登录，不必打扰）；
 *  3. 同站有「同用户名」但密码不同的条目 → update 该条目（密码被改了）；
 *  4. 否则 → create。
 */
export function decideSaveAction(
  items: readonly CredentialItem[],
  draft: CredentialDraft,
  writable: readonly BackendSource[],
): SaveDecision {
  if (writable.length === 0) return { action: 'none', sources: [] };

  const sameUser = items.filter(
    (item) =>
      item.username.trim().length > 0 && normalize(item.username) === normalize(draft.username),
  );
  if (sameUser.some((item) => item.password === draft.password)) {
    return { action: 'none', sources: writable };
  }

  // items 已按默认库优先排序，优先更新默认库里的那条
  const target = sameUser.find((item) => writable.includes(item.source)) ?? sameUser[0];
  if (target === undefined) return { action: 'create', sources: writable };
  if (!writable.includes(target.source)) return { action: 'none', sources: [] };

  return {
    action: 'update',
    target: {
      source: target.source,
      id: target.id,
      name: target.name,
      username: target.username,
    },
    sources: [target.source],
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * 校验并收敛来自内容脚本的草稿：只保留契约里的字段，缺失或类型不符则拒绝。
 * 防止把任意结构透传给适配器。
 */
export function coerceDraft(value: unknown): CredentialDraft | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const url = asString(candidate.url);
  const username = asString(candidate.username);
  const password = asString(candidate.password);
  if (url === undefined || username === undefined || password === undefined) return null;
  if (url.length === 0 || username.length === 0 || password.length === 0) return null;
  if (!/^https?:\/\//i.test(url)) return null;

  const name = asString(candidate.name);
  const uuid = asString(candidate.uuid);
  const folder = asString(candidate.folder);
  return {
    url,
    username,
    password,
    ...(name !== undefined && name.length > 0 ? { name } : {}),
    ...(uuid !== undefined && uuid.length > 0 ? { uuid } : {}),
    ...(folder !== undefined && folder.length > 0 ? { folder } : {}),
  };
}
