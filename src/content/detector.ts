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
const TEXT_LIKE_TYPES = new Set(['text', 'tel', 'email', 'number', 'search']);
/** 小于这个尺寸的输入框视为不可见（防止被 1px 隐藏表单利用） */
const MIN_VISIBLE_WIDTH = 24;
const MIN_VISIBLE_HEIGHT = 10;

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

/** 单个输入框的类别；无提示性命名的普通文本框返回 null（兜底规则见 collectCredentialInputs）。 */
export function classifyInput(input: HTMLInputElement): FieldKind | null {
  const type = input.type.toLowerCase();
  if (type === 'hidden' || input.disabled || input.readOnly) return null;
  const autocomplete = input.autocomplete.toLowerCase();
  if (autocomplete === 'one-time-code') return 'totp';
  if (type === 'password') {
    return autocomplete.includes('one-time-code') ? 'totp' : 'password';
  }
  // 邮箱框几乎总是账号框，不需要再靠 name / id 命中关键字
  if (type === 'email') return 'username';
  if (type !== 'text' && type !== 'tel' && type !== 'number') {
    return null;
  }
  const { username, totp } = hintScore(input);
  if (totp > 0 && totp >= username) return 'totp';
  if (username > 0) return 'username';
  return null;
}

/**
 * 列出所有可识别的字段（不按类别去重），按文档顺序排列。
 * 账号框兜底规则：某个表单里找不到可识别的账号框时，紧挨在首个密码框之前的
 * 文本类输入框视为账号框——大量登录表单的账号框只有 type="text"，没有任何提示性命名。
 */
export function collectCredentialInputs(root: Node = document): readonly DetectedField[] {
  const inputs: HTMLInputElement[] = [];
  collectInputs(root, inputs);

  const kinds = new Map<HTMLInputElement, FieldKind | null>();
  const formsWithUsername = new Set<HTMLFormElement | null>();
  for (const input of inputs) {
    const kind = classifyInput(input);
    kinds.set(input, kind);
    if (kind === 'username') formsWithUsername.add(input.form ?? null);
  }

  const handledForms = new Set<HTMLFormElement | null>();
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    if (input === undefined || kinds.get(input) !== 'password') continue;
    const form = input.form ?? null;
    if (handledForms.has(form)) continue;
    handledForms.add(form);
    if (formsWithUsername.has(form)) continue;

    const previous = inputs[index - 1];
    if (previous === undefined || kinds.get(previous) !== null) continue;
    if (!TEXT_LIKE_TYPES.has(previous.type.toLowerCase())) continue;
    if ((previous.form ?? null) !== form) continue;
    kinds.set(previous, 'username');
    formsWithUsername.add(form);
  }

  const fields: DetectedField[] = [];
  for (const input of inputs) {
    const kind = kinds.get(input) ?? null;
    if (kind !== null) fields.push({ kind, element: input });
  }
  return fields;
}

export function detectFields(root: Node = document): readonly DetectedField[] {
  const fields: DetectedField[] = [];
  const seen = new Set<FieldKind>();
  for (const field of collectCredentialInputs(root)) {
    // 每类只填第一个字段，避免把同一密码灌进确认框
    if (seen.has(field.kind)) continue;
    seen.add(field.kind);
    fields.push(field);
  }
  return fields;
}

/** 输入框是否真的看得见、点得到。浮层与自动填充只针对可见字段。 */
export function isFieldVisible(input: HTMLInputElement): boolean {
  const type = input.type.toLowerCase();
  if (type === 'hidden' || input.disabled || input.readOnly) return false;
  const rect = input.getBoundingClientRect();
  if (rect.width < MIN_VISIBLE_WIDTH || rect.height < MIN_VISIBLE_HEIGHT) return false;
  for (let element: HTMLElement | null = input; element !== null; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    ) {
      return false;
    }
  }
  return true;
}

/** 给密码框找配套的账号框：同表单内优先，否则取文档顺序上最近的一个。 */
export function pairUsernameFor(password: HTMLInputElement): HTMLInputElement | undefined {
  const form = password.form;
  if (form) {
    const inside = collectCredentialInputs(form).find(
      (field) => field.kind === 'username',
    )?.element;
    if (inside !== undefined && inside !== password) return inside;
  }
  const ordered = collectCredentialInputs(document).filter(
    (field) => field.kind === 'username' || field.kind === 'password',
  );
  const index = ordered.findIndex((field) => field.element === password);
  if (index < 0) return undefined;
  for (let i = index - 1; i >= 0; i -= 1) {
    const field = ordered[i];
    if (field?.kind === 'username') return field.element;
  }
  return ordered.slice(index + 1).find((field) => field.kind === 'username')?.element;
}

/**
 * 一次 DOM 变动是否可能与登录字段有关：新增 / 删除了输入框（或含有输入框的子树），
 * 或者改动了输入框及其祖先的属性（例如登录弹窗由隐藏变为显示）。
 * 用于把 React 这类频繁重渲染的噪声挡在重新扫描之外。
 */
export function isFieldRelevantMutation(record: MutationRecord): boolean {
  if (record.type === 'attributes') {
    return (
      record.target instanceof Element &&
      (record.target instanceof HTMLInputElement || record.target.querySelector('input') !== null)
    );
  }
  const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
  return nodes.some(
    (node) =>
      node instanceof HTMLInputElement ||
      (node instanceof Element && node.querySelector('input') !== null),
  );
}

/** 动态表单监听：字段集合变化时回调（T-3） */
export function observeFields(
  root: ParentNode & Node,
  onChange: (records: readonly MutationRecord[]) => void,
): MutationObserver {
  const observer = new MutationObserver((records) => {
    onChange(records);
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'name', 'id', 'autocomplete', 'style'],
  });
  return observer;
}

/** 从表单中提取保存候选；只读取用户已输入的值，不写入页面（S-4） */
export function collectSaveCandidate(form: HTMLFormElement): {
  readonly url: string;
  readonly username: string;
  readonly password: string;
} | null {
  const fields = detectFields(form);
  const password = fields.find((field) => field.kind === 'password')?.element.value;
  const username = fields.find((field) => field.kind === 'username')?.element.value;
  if (!password || !username) return null;
  return { url: location.href, username, password };
}
