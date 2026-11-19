/** Popup UI：只依赖 core 契约，不 import 任何适配器（E-2）。 */
import type { MergeResult } from '../core/merger.js';
import type { BackendSource, CredentialItem } from '../core/types.js';
import { MSG, type PendingSaveResponse, type StatusResponse } from '../shared/messages.js';
import { STRINGS } from './strings.js';

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element: ${id}`);
  return element;
}

async function request(message: Record<string, unknown>): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

async function send(type: string, extra: Record<string, unknown> = {}): Promise<void> {
  await chrome.runtime.sendMessage({ type, ...extra });
}

const statusEl = byId('status');
const statusDotEl = byId('status-dot');
const unlockPanel = byId('unlock-panel');
const resultsEl = byId('results');
const contextRow = byId('context-row');
const siteHostEl = byId('site-host');
const masterInput = byId('master-password') as HTMLInputElement;
const otpInput = byId('two-factor') as HTMLInputElement;
const lockBtn = byId('lock') as HTMLButtonElement;

let baseStatus: string = STRINGS.locked;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

function sourceLabel(source: BackendSource): string {
  return source === 'bitwarden' ? 'Bitwarden' : 'KeePassXC';
}

function sourceBadge(source: BackendSource): string {
  return source === 'bitwarden' ? 'BW' : 'KP';
}

/** 短暂显示操作反馈，随后恢复真实状态文字。 */
function flashStatus(text: string): void {
  if (flashTimer !== null) clearTimeout(flashTimer);
  statusEl.textContent = text;
  flashTimer = setTimeout(() => {
    statusEl.textContent = baseStatus;
    flashTimer = null;
  }, 1800);
}

function setState(status: StatusResponse): void {
  baseStatus =
    status.state === 'unlocked'
      ? STRINGS.unlocked
      : status.state === 'suspended'
        ? STRINGS.suspended
        : STRINGS.locked;
  statusEl.textContent = baseStatus;
  statusDotEl.className = `status-dot ${status.state}`;
  unlockPanel.hidden = status.state === 'unlocked';
  lockBtn.hidden = status.state !== 'unlocked';
}

function stateBox(message: string, spinner = false): HTMLElement {
  const box = document.createElement('div');
  box.className = 'state-box';
  if (spinner) {
    const dot = document.createElement('div');
    dot.className = 'spinner';
    box.append(dot);
  } else {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.7');
    icon.setAttribute('stroke-linecap', 'round');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M4 7h16M4 12h16M4 17h10');
    icon.append(path);
    box.append(icon);
  }
  const text = document.createElement('span');
  text.textContent = message;
  box.append(text);
  return box;
}

function renderItem(item: CredentialItem): HTMLElement {
  const row = document.createElement('article');
  row.className = 'cred-card';

  const head = document.createElement('div');
  head.className = 'cred-head';

  const badge = document.createElement('span');
  badge.className = `source-badge ${item.source}`;
  badge.textContent = sourceBadge(item.source);
  head.append(badge);

  const meta = document.createElement('div');
  meta.className = 'cred-meta';
  const title = document.createElement('strong');
  title.textContent = item.name;
  const subtitle = document.createElement('span');
  subtitle.textContent = item.username;
  meta.append(title, subtitle);
  head.append(meta);

  const origin = document.createElement('span');
  origin.className = 'cred-source';
  origin.textContent = sourceLabel(item.source);
  head.append(origin);
  row.append(head);

  const actions = document.createElement('div');
  actions.className = 'cred-actions';

  type Plan = {
    readonly username?: string;
    readonly password?: string;
    readonly totp?: string;
  };
  const buttons: [string, Plan, boolean][] = [
    [STRINGS.fillUsername, { username: item.username }, true],
    [STRINGS.fillPassword, { password: item.password }, true],
  ];
  if (item.totp !== undefined) {
    const totp = item.totp;
    buttons.push([STRINGS.fillTotp, { totp }, false]);
  }

  for (const [label, plan, primary] of buttons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = primary ? 'act primary' : 'act';
    button.textContent = label;
    button.addEventListener('click', () => {
      void send(MSG.FILL, { plan }).then(() => {
        flashStatus(`已填充${label.replace('填', '')}`);
      });
    });
    actions.append(button);
  }

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'act';
  copy.textContent = STRINGS.copyPassword;
  copy.addEventListener('click', () => {
    void send(MSG.COPY, { text: item.password }).then(() => {
      flashStatus('已复制，30 秒后自动清空');
    });
  });
  actions.append(copy);
  row.append(actions);
  return row;
}

async function renderSavePrompt(): Promise<void> {
  const pending = (await request({ type: MSG.PENDING_SAVE })) as PendingSaveResponse;
  if (!pending.draft || pending.sources.length === 0) return;

  const container = document.createElement('section');
  container.className = 'save-prompt';

  const title = document.createElement('div');
  title.className = 'prompt-title';
  title.textContent = STRINGS.savePrompt;
  container.append(title);

  const detail = document.createElement('div');
  detail.className = 'prompt-detail';
  let host = pending.draft.url;
  try {
    host = new URL(pending.draft.url).hostname;
  } catch {
    /* 保留原始值 */
  }
  detail.textContent = `${host} · ${pending.draft.username}`;
  container.append(detail);

  const actions = document.createElement('div');
  actions.className = 'cred-actions';
  const decide = async (source: BackendSource | null): Promise<void> => {
    const result = (await request({
      type: MSG.SAVE_DECISION,
      draft: pending.draft,
      source,
    })) as { ok: boolean };
    flashStatus(result.ok ? `已保存到 ${source ? sourceLabel(source) : ''}` : '保存失败或未选择');
    container.remove();
  };

  for (const source of pending.sources) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'act primary';
    button.textContent = `${STRINGS.saveTo} ${sourceLabel(source)}`;
    button.addEventListener('click', () => {
      void decide(source);
    });
    actions.append(button);
  }
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'act';
  cancel.textContent = STRINGS.cancel;
  cancel.addEventListener('click', () => {
    void decide(null);
  });
  actions.append(cancel);

  container.append(actions);
  resultsEl.prepend(container);
}

async function refresh(): Promise<void> {
  const status = (await request({ type: MSG.STATUS })) as StatusResponse;
  setState(status);

  if (status.state !== 'unlocked') {
    contextRow.hidden = true;
    resultsEl.replaceChildren(
      stateBox(status.state === 'suspended' ? STRINGS.suspendedHint : STRINGS.lockedHint),
    );
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url) {
    contextRow.hidden = true;
    resultsEl.replaceChildren(stateBox(STRINGS.noTab));
    return;
  }
  contextRow.hidden = false;
  try {
    siteHostEl.textContent = new URL(tab.url).hostname;
  } catch {
    siteHostEl.textContent = tab.url;
  }

  resultsEl.replaceChildren(stateBox(STRINGS.searching, true));
  const result = (await request({
    type: MSG.SEARCH,
    query: { url: tab.url },
  })) as MergeResult;

  resultsEl.replaceChildren();
  if (result.ambiguous) {
    const note = document.createElement('div');
    note.className = 'notice';
    note.textContent = STRINGS.ambiguous;
    resultsEl.append(note);
  }
  if (result.items.length === 0) {
    resultsEl.append(stateBox(STRINGS.noItems));
    return;
  }
  for (const item of result.items) resultsEl.append(renderItem(item));
  if (status.canWrite) await renderSavePrompt();
}

async function unlock(): Promise<void> {
  const password = masterInput.value;
  const otp = otpInput.value;
  if (password.length === 0) {
    flashStatus('请输入主密码');
    masterInput.focus();
    return;
  }
  const result = (await request({
    type: MSG.UNLOCK,
    masterPassword: password,
    twoFactorCode: otp || undefined,
  })) as { ok: boolean };
  masterInput.value = '';
  otpInput.value = '';
  if (!result.ok) {
    flashStatus('解锁失败，请检查主密码或验证码');
    return;
  }
  await refresh();
}

async function lock(): Promise<void> {
  await send(MSG.LOCK);
  await refresh();
}

byId('unlock').addEventListener('click', () => {
  void unlock();
});
lockBtn.addEventListener('click', () => {
  void lock();
});
byId('open-options').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
});
masterInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void unlock();
});
otpInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void unlock();
});

void refresh();
