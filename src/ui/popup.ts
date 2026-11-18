/** Popup UI：只依赖 core 契约，不 import 任何适配器（E-2）。 */
import type { MergeResult } from '../core/merger.js';
import type { CredentialItem } from '../core/types.js';
import { MSG, type StatusResponse } from '../shared/messages.js';
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
const resultsEl = byId('results');
const masterInput = byId('master-password') as HTMLInputElement;
const otpInput = byId('two-factor') as HTMLInputElement;

function sourceLabel(source: string): string {
  return source === 'bitwarden' ? 'Bitwarden' : 'KeePassXC';
}

function renderItem(item: CredentialItem): HTMLElement {
  const row = document.createElement('div');
  row.className = 'item';

  const title = document.createElement('div');
  title.className = 'item-title';
  title.textContent = `${item.name} · ${sourceLabel(item.source)}`;
  row.append(title);

  const subtitle = document.createElement('div');
  subtitle.className = 'item-subtitle';
  subtitle.textContent = item.username;
  row.append(subtitle);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const buttons: [string, () => void][] = [
    [
      STRINGS.fillUsername,
      () => {
        void send(MSG.FILL, { plan: { username: item.username } });
      },
    ],
    [
      STRINGS.fillPassword,
      () => {
        void send(MSG.FILL, { plan: { password: item.password } });
      },
    ],
  ];
  if (item.totp !== undefined) {
    const totp = item.totp;
    buttons.push([
      STRINGS.fillTotp,
      () => {
        void send(MSG.FILL, { plan: { totp } });
      },
    ]);
  }
  buttons.push([
    STRINGS.copyPassword,
    () => {
      void send(MSG.COPY, { text: item.password });
      statusEl.textContent = '已复制，30 秒后自动清空';
    },
  ]);

  for (const [label, onClick] of buttons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', onClick);
    actions.append(button);
  }
  row.append(actions);
  return row;
}

async function refresh(): Promise<void> {
  const status = (await request({ type: MSG.STATUS })) as StatusResponse;
  statusEl.textContent = status.state === 'unlocked' ? STRINGS.unlocked : STRINGS.locked;

  if (status.state !== 'unlocked') {
    resultsEl.textContent = STRINGS.locked;
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url) return;
  resultsEl.textContent = STRINGS.searching;
  const result = (await request({
    type: MSG.SEARCH,
    query: { url: tab.url },
  })) as MergeResult;
  resultsEl.replaceChildren();
  if (result.ambiguous) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = STRINGS.ambiguous;
    resultsEl.append(note);
  }
  if (result.items.length === 0) {
    resultsEl.append(document.createTextNode(STRINGS.noItems));
    return;
  }
  for (const item of result.items) resultsEl.append(renderItem(item));
}

async function unlock(): Promise<void> {
  const result = (await request({
    type: MSG.UNLOCK,
    masterPassword: masterInput.value,
    twoFactorCode: otpInput.value || undefined,
  })) as { ok: boolean };
  masterInput.value = '';
  otpInput.value = '';
  statusEl.textContent = result.ok ? STRINGS.unlocked : '解锁失败';
  if (result.ok) await refresh();
}

async function lock(): Promise<void> {
  await send(MSG.LOCK);
  statusEl.textContent = STRINGS.locked;
  resultsEl.replaceChildren();
}

byId('unlock').addEventListener('click', () => {
  void unlock();
});
byId('lock').addEventListener('click', () => {
  void lock();
});

void refresh();
