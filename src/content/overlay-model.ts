/**
 * 页内浮层的纯逻辑：过滤、键盘步进、定位计算、自动填充判定。
 * 不碰 DOM，便于单测；overlay.ts 只负责把这些结果画出来。
 */
import type { Suggestion } from '../core/suggest.js';

/**
 * 按已输入的文字过滤候选（匹配名称或用户名，不区分大小写）。
 * 没有任何命中时仍返回全部——避免用户打字把候选"打没"，无处可选。
 */
export function filterSuggestions(
  items: readonly Suggestion[],
  query: string,
): readonly Suggestion[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return items;
  const hits = items.filter(
    (item) =>
      item.name.toLowerCase().includes(needle) || item.username.toLowerCase().includes(needle),
  );
  return hits.length > 0 ? hits : items;
}

/** 键盘上下键移动高亮。current = -1 表示没有高亮；无候选时始终返回 -1。 */
export function stepSelection(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return (current + delta + length) % length;
}

export interface Box {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** 输入框内小图标的位置：贴右缘、垂直居中 */
export function placeIcon(
  field: Box,
  size = 22,
  inset = 8,
): { readonly left: number; readonly top: number } {
  return {
    left: field.left + field.width - size - inset,
    top: field.top + Math.max(0, (field.height - size) / 2),
  };
}

export const PANEL_LIMITS = {
  minWidth: 300,
  maxWidth: 380,
  margin: 8,
  gap: 6,
  maxHeight: 420,
  /** 下方至少要有这么多空间才往下展开，否则翻到输入框上方 */
  minHeight: 140,
} as const;

/** 候选面板的位置：默认在输入框下方，空间不够时翻到上方；宽度随输入框伸缩并夹在视口内。 */
export function placePanel(
  field: Box,
  viewport: { readonly width: number; readonly height: number },
  limits = PANEL_LIMITS,
): {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly maxHeight: number;
  readonly placement: 'below' | 'above';
} {
  const safeWidth = Math.max(0, viewport.width - limits.margin * 2);
  const width = Math.min(limits.maxWidth, Math.max(limits.minWidth, field.width), safeWidth);
  const left = Math.min(
    Math.max(field.left, limits.margin),
    Math.max(0, viewport.width - width - limits.margin),
  );

  const belowTop = field.top + field.height + limits.gap;
  const spaceBelow = viewport.height - limits.margin - belowTop;
  const spaceAbove = field.top - limits.gap - limits.margin;
  const placement = spaceBelow < limits.minHeight && spaceAbove > spaceBelow ? 'above' : 'below';
  const maxHeight = Math.max(
    0,
    Math.min(limits.maxHeight, placement === 'above' ? spaceAbove : spaceBelow),
  );
  const top =
    placement === 'above' ? Math.max(limits.margin, field.top - limits.gap - maxHeight) : belowTop;

  return { left, top, width, maxHeight, placement };
}

/** 页面顶部居中的保存提示条 */
export function placeBar(
  viewport: { readonly width: number; readonly height: number },
  preferredWidth = 420,
  margin = 16,
): { readonly left: number; readonly top: number; readonly width: number } {
  const width = Math.max(0, Math.min(preferredWidth, viewport.width - margin * 2));
  return { left: Math.max(0, (viewport.width - width) / 2), top: margin, width };
}

export interface AutoFillConditions {
  /** 设置页的「打开网页时自动填充」 */
  readonly enabled: boolean;
  /** 当前站点匹配到的候选数：只有唯一匹配才自动填 */
  readonly matchCount: number;
  readonly usernameEmpty: boolean;
  readonly passwordEmpty: boolean;
  /** 自动填充只针对 https，明文 http 页面只给候选 */
  readonly secureContext: boolean;
  /** 只在顶层页面自动填，iframe 不自动填 */
  readonly topFrame: boolean;
}

/**
 * 是否满足页面加载后自动填充的条件。
 * 全部条件都成立才填：任何一项不满足都只展示候选，由用户自己选。
 */
export function shouldAutoFill(conditions: AutoFillConditions): boolean {
  return (
    conditions.enabled &&
    conditions.matchCount === 1 &&
    conditions.usernameEmpty &&
    conditions.passwordEmpty &&
    conditions.secureContext &&
    conditions.topFrame
  );
}

/** 从一堆候选里挑验证码该填给谁：优先刚填充过的那条，否则第一条带验证码的 */
export function pickTotpSource(
  items: readonly Suggestion[],
  lastFilled: { readonly source: string; readonly id: string } | null,
): Suggestion | undefined {
  const withTotp = items.filter((item) => item.hasTotp);
  return (
    withTotp.find(
      (item) =>
        lastFilled !== null && item.id === lastFilled.id && item.source === lastFilled.source,
    ) ?? withTotp[0]
  );
}
