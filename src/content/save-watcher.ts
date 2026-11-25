/**
 * 保存检测：判断「用户真的提交了一个账号密码」这件事何时发生。
 *
 * 误报比漏报更伤体验——点一下"显示密码"的小眼睛、或者校验没通过，都不该问"要保存吗"。
 * 所以这里用「提交成功后的痕迹」作为信号：表单消失、被清空、或路由跳转。
 *
 * 三种触发都会进入同一套"消失检查"：
 *  - form 的 submit 事件（经典表单、React 等）；
 *  - 点击按钮类元素（不触发 submit 事件的 SPA）；
 *  - 在账号 / 密码框里按回车。
 *
 * 经典表单会整页跳转，内容脚本随之销毁，所以 submit 触发时先把草稿交给 background
 * 暂存（stage）——即使这一页来不及显示提示条，下一页也能接着问。
 *
 * 两种值不算"用户输入的新密码"：
 *  - 我们自己用填充服务写进去的（用户没改过，无需再问）；
 *  - 用户输入之后被站点脚本替换掉的（例如提交前把密码框换成哈希）。
 *  因此取值以「用户最后一次输入事件时的值」为准。
 */
import type { SaveCheckResponse } from '../shared/messages.js';
import type { CredentialDraft } from '../core/types.js';
import {
  classifyInput,
  collectCredentialInputs,
  isFieldVisible,
  pairUsernameFor,
} from './detector.js';

export interface SaveWatcherDeps {
  /** 先交给后台判定并暂存：随后即使整页跳转，下一页也能接着提示 */
  readonly stage: (draft: CredentialDraft) => Promise<SaveCheckResponse | null>;
  /** 提交已确认成功，正式弹出保存提示。decision 为 null 时由调用方现场判定 */
  readonly offer: (draft: CredentialDraft, decision: SaveCheckResponse | null) => void;
  readonly pageUrl: () => string;
}

export interface SaveWatcher {
  /** 记录"这个值是我们自己填进去的"：用户没有改动过就不必问要不要保存 */
  noteProgrammaticFill(input: HTMLInputElement, value: string): void;
  dispose(): void;
}

const BUTTON_LIKE = 'button, input[type="submit"], input[type="button"], [role="button"]';
const FIRST_CHECK_MS = 1000;
const SECOND_CHECK_MS = 2500;

export function startSaveWatcher(doc: Document, deps: SaveWatcherDeps): SaveWatcher {
  const maybeView = doc.defaultView;
  const typed = new WeakMap<HTMLInputElement, string>();
  const filledByUs = new WeakMap<HTMLInputElement, string>();
  const timers = new Set<number>();
  let lastTypedPassword: HTMLInputElement | null = null;

  if (maybeView === null) {
    return {
      noteProgrammaticFill: () => {},
      dispose: () => {},
    };
  }
  // 显式标注为非空：被提升的内部函数无法沿用上面的空值收窄
  const view: Window = maybeView;

  function noteProgrammaticFill(input: HTMLInputElement, value: string): void {
    filledByUs.set(input, value);
  }

  function onInput(event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    const input = event.target;
    const kind = classifyInput(input);
    if (kind !== 'password' && kind !== 'username') return;
    // 我们自己填充时也会派发 input 事件；值没变就不算用户输入
    if (filledByUs.get(input) === input.value) return;
    typed.set(input, input.value);
    if (kind === 'password') lastTypedPassword = input;
  }

  function candidateFor(password: HTMLInputElement): CredentialDraft | null {
    const typedValue = typed.get(password);
    let secret: string;
    if (typedValue !== undefined && typedValue.length > 0) {
      secret = typedValue;
    } else if (filledByUs.has(password)) {
      return null;
    } else if (password.value.length > 0) {
      // 浏览器密码管理器或站点自己预填的：同样值得问一句要不要收进密码库
      secret = password.value;
    } else {
      return null;
    }

    const usernameField = pairUsernameFor(password);
    const typedUser = usernameField === undefined ? undefined : typed.get(usernameField);
    const username =
      typedUser !== undefined && typedUser.length > 0 ? typedUser : (usernameField?.value ?? '');
    if (username.trim().length === 0) return null;
    return { url: deps.pageUrl(), username, password: secret };
  }

  function pickPassword(form: HTMLFormElement | null): HTMLInputElement | null {
    if (form === null && lastTypedPassword !== null && lastTypedPassword.isConnected) {
      return lastTypedPassword;
    }
    const passwords = collectCredentialInputs(form ?? doc)
      .filter((field) => field.kind === 'password')
      .map((field) => field.element);
    return passwords.find((input) => typed.has(input)) ?? passwords[0] ?? null;
  }

  function whenSubmitted(password: HTMLInputElement, onConfirmed: () => void): void {
    const url = deps.pageUrl();
    const gone = (): boolean =>
      !password.isConnected ||
      password.value.length === 0 ||
      !isFieldVisible(password) ||
      deps.pageUrl() !== url;

    const second = view.setTimeout(() => {
      timers.delete(second);
      if (gone()) onConfirmed();
    }, SECOND_CHECK_MS);
    timers.add(second);
    const first = view.setTimeout(() => {
      timers.delete(first);
      if (gone()) {
        view.clearTimeout(second);
        timers.delete(second);
        onConfirmed();
      }
    }, FIRST_CHECK_MS);
    timers.add(first);
  }

  function onSubmit(event: Event): void {
    if (!(event.target instanceof HTMLFormElement)) return;
    const password = pickPassword(event.target);
    if (password === null) return;
    const draft = candidateFor(password);
    if (draft === null) return;
    void deps.stage(draft).then((decision) => {
      if (decision === null || decision.action === 'none') return;
      whenSubmitted(password, () => {
        deps.offer(draft, decision);
      });
    });
  }

  function checkSubmission(scope: HTMLFormElement | null): void {
    const password = pickPassword(scope);
    if (password === null) return;
    const draft = candidateFor(password);
    if (draft === null) return;
    whenSubmitted(password, () => {
      deps.offer(draft, null);
    });
  }

  function onClick(event: Event): void {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest(BUTTON_LIKE);
    if (control === null) return;
    const owner =
      control instanceof HTMLButtonElement || control instanceof HTMLInputElement
        ? control.form
        : null;
    checkSubmission(owner ?? control.closest('form'));
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!(event.target instanceof HTMLInputElement) || event.key !== 'Enter') return;
    const kind = classifyInput(event.target);
    if (kind !== 'username' && kind !== 'password') return;
    checkSubmission(event.target.form);
  }

  doc.addEventListener('input', onInput, true);
  doc.addEventListener('submit', onSubmit, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKeyDown, true);

  return {
    noteProgrammaticFill,
    dispose: () => {
      doc.removeEventListener('input', onInput, true);
      doc.removeEventListener('submit', onSubmit, true);
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('keydown', onKeyDown, true);
      for (const timer of timers) view.clearTimeout(timer);
      timers.clear();
    },
  };
}
