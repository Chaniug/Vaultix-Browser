/**
 * 填充引擎（S-4）：只写 input.value 并派发 input/change 事件。
 * 绝不把凭证写入页面可读的属性、全局变量或 DOM 节点特性。
 */
import type { FillPlan } from '../core/fill.js';
import type { DetectedField } from './detector.js';

export type { FillPlan };

export function fillFields(fields: readonly DetectedField[], plan: FillPlan): number {
  let filled = 0;
  for (const field of fields) {
    const value = plan[field.kind];
    if (value === undefined || value.length === 0) continue;
    field.element.value = value;
    field.element.dispatchEvent(new Event('input', { bubbles: true }));
    field.element.dispatchEvent(new Event('change', { bubbles: true }));
    filled += 1;
  }
  return filled;
}
