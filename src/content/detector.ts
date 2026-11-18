/**
 * 表单字段识别（T-3）：普通表单、Shadow DOM、动态加载表单。
 * 只读取 DOM 结构，不接触任何凭证值（S-4）。
 */
export type FieldKind = 'username' | 'password' | 'totp';

export interface DetectedField {
  readonly kind: FieldKind;
  readonly element: HTMLInputElement;
}

const USERNAME_HINTS = ['user', 'login', 'email', 'account', 'identifier', 'username'];
const TOTP_HINTS = ['totp', 'otp', 'one-time', 'onetime', 'verification'];

function collectInputs(root: Node, out: HTMLInputElement[]): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.currentNode;
  while (node !== null) {
    if (node instanceof HTMLInputElement) out.push(node);
    const shadow = (node as Element).shadowRoot;
    if (shadow) collectInputs(shadow, out);
    node = walker.nextNode();
  }
}

function hintScore(input: HTMLInputElement): { username: number; totp: number } {
  const raw = [input.name, input.id, input.autocomplete, input.placeholder]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return {
    username: USERNAME_HINTS.reduce((n, hint) => n + (raw.includes(hint) ? 1 : 0), 0),
    totp: TOTP_HINTS.reduce((n, hint) => n + (raw.includes(hint) ? 1 : 0), 0),
  };
}

function classify(input: HTMLInputElement): FieldKind | null {
  const type = input.type.toLowerCase();
  if (type === 'hidden' || input.disabled || input.readOnly) return null;
  const autocomplete = input.autocomplete.toLowerCase();
  if (autocomplete === 'one-time-code') return 'totp';
  if (type === 'password') {
    return autocomplete.includes('one-time-code') ? 'totp' : 'password';
  }
  if (type !== 'text' && type !== 'email' && type !== 'tel' && type !== 'number') {
    return null;
  }
  const { username, totp } = hintScore(input);
  if (totp > 0 && totp >= username) return 'totp';
  if (username > 0) return 'username';
  return null;
}

export function detectFields(root: Node = document): readonly DetectedField[] {
  const inputs: HTMLInputElement[] = [];
  collectInputs(root, inputs);
  const fields: DetectedField[] = [];
  const seen = new Set<FieldKind>();
  for (const input of inputs) {
    const kind = classify(input);
    if (kind === null) continue;
    // 每类只填第一个可见字段，避免把同一密码灌进确认框
    if (seen.has(kind)) continue;
    seen.add(kind);
    fields.push({ kind, element: input });
  }
  return fields;
}

/** 动态表单监听：字段集合变化时回调（T-3） */
export function observeFields(root: ParentNode & Node, onChange: () => void): MutationObserver {
  const observer = new MutationObserver(() => {
    onChange();
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'name', 'id', 'autocomplete', 'style'],
  });
  return observer;
}
