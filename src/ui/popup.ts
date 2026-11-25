/** Popup UI：只依赖 core 契约，不 import 任何适配器（E-2）。 */
import type { FillField } from '../core/fill.js';
import type { SearchView, Suggestion } from '../core/suggest.js';
import type { BackendSource } from '../core/types.js';
import {
  MSG,
  type FillItemResponse,
  type PendingSaveResponse,
  type StatusResponse,
} from '../shared/messages.js';
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
const siteOptInBtn = byId('site-optin') as HTMLButtonElement;
const masterInput = byId('master-password') as HTMLInputElement;
const otpInput = byId('two-factor') as HTMLInputElement;
const lockBtn = byId('lock') as HTMLButtonElement;
const sourceTabs: Record<BackendSource, HTMLButtonElement> = {
  keepassxc: byId('source-keepassxc') as HTMLButtonElement,
  bitwarden: byId('source-bitwarden') as HTMLButtonElement,
};

let baseStatus: string = STRINGS.locked;
let flashTimer: ReturnType<typeof setTimeout> | null = null;
/** 当前标签页地址；填充与"本站启用"都针对它 */
let pageUrl = '';
let siteGranted = false;

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

/** 状态文字反映两库可用性，而非单一全局锁；Bitwarden 会话锁只描述它自己。 */
function statusText(status: StatusResponse): string {
  const bw = status.bitwardenReady;
  const kp = status.keepassReady;
  if (bw && kp) return STRINGS.bothReady;
  if (bw) return STRINGS.bitwardenReady;
  if (kp) return STRINGS.keepassReady;
  return STRINGS.noneReady;
}

function setState(status: StatusResponse): void {
  baseStatus = statusText(status);
  statusEl.textContent = baseStatus;
  statusDotEl.className = `status-dot ${status.anyReady ? 'unlocked' : 'locked'}`;

  for (const source of ['bitwarden', 'keepassxc'] as const) {
    sourceTabs[source].classList.toggle('active', status.defaultFillSource === source);
    sourceTabs[source].setAttribute('aria-pressed', String(status.defaultFillSource === source));
  }

  // 只有 Bitwarden 需要登录；已登录或首页选的是 KeePassXC 时都收起登录框
  unlockPanel.hidden = status.bitwardenReady || status.defaultFillSource !== 'bitwarden';
  lockBtn.hidden = !status.bitwardenReady;
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

/** 带一个主操作按钮的提示盒，用于把"引导"变成"一步到位"。 */
function actionBox(message: string, label: string, onClick: () => Promise<void>): HTMLElement {
  const box = stateBox(message);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'act primary';
  button.textContent = label;
  button.addEventListener('click', () => {
    void onClick();
  });
  box.append(button);
  return box;
}

/**
 * 所有填充都走统一填充服务：这里只报「哪条凭证 + 哪些字段」，
 * 真实的用户名 / 密码 / 即时验证码由 background 取出后写进页面。
 */
async function fillItem(
  item: Suggestion,
  fields: readonly FillField[],
  copyTotp: boolean,
): Promise<FillItemResponse | null> {
  return (await request({
    type: MSG.FILL_ITEM,
    source: item.source,
    id: item.id,
    fields,
    url: pageUrl,
    copyTotp,
  })) as FillItemResponse | null;
}

function actionButton(
  label: string,
  onClick: () => Promise<void>,
  primary = false,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = primary ? 'act primary' : 'act';
  button.textContent = label;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    void onClick();
  });
  return button;
}

function renderItem(item: Suggestion): HTMLElement {
  const row = document.createElement('article');
  row.className = 'cred-card';
  row.setAttribute('role', 'button');
  row.tabIndex = 0;

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

  const fillAll = async (): Promise<void> => {
    const result = await fillItem(item, ['username', 'password', 'totp'], item.hasTotp);
    if (result?.ok !== true) {
      flashStatus(STRINGS.fillFailed);
      return;
    }
    // 填充成功后收起面板，让用户直接看到填好的页面（验证码已由后台复制）
    window.close();
  };

  const actions = document.createElement('div');
  actions.className = 'cred-actions';
  actions.append(actionButton(STRINGS.fill, fillAll, true));
  if (item.hasTotp) {
    actions.append(
      actionButton(STRINGS.fillTotp, async () => {
        const result = await fillItem(item, ['totp'], true);
        flashStatus(result?.ok === true ? STRINGS.totpFilled : STRINGS.fillFailed);
      }),
    );
  }
  actions.append(
    actionButton(STRINGS.copyPassword, async () => {
      const result = (await request({
        type: MSG.COPY_ITEM,
        source: item.source,
        id: item.id,
        kind: 'password',
        url: pageUrl,
      })) as { ok: boolean } | null;
      flashStatus(result?.ok === true ? STRINGS.copied : STRINGS.copyFailed);
    }),
  );
  row.append(actions);

  // 点整行即填充；点行内按钮只触发按钮自身的动作
  row.addEventListener('click', () => {
    void fillAll();
  });
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void fillAll();
    }
  });
  return row;
}

async function renderSavePrompt(): Promise<void> {
  const pending = (await request({ type: MSG.PENDING_SAVE })) as PendingSaveResponse | null;
  if (pending === null || pending.decision.sources.length === 0) return;

  const container = document.createElement('section');
  container.className = 'save-prompt';

  const target = pending.decision.target;
  const update = pending.decision.action === 'update' && target !== undefined;
  const title = document.createElement('div');
  title.className = 'prompt-title';
  title.textContent = update ? `密码已更改，更新「${target.name}」？` : STRINGS.savePrompt;
  container.append(title);

  const detail = document.createElement('div');
  detail.className = 'prompt-detail';
  detail.textContent = `${pending.host} · ${pending.username}`;
  container.append(detail);

  const actions = document.createElement('div');
  actions.className = 'cred-actions';
  const updatedText = target !== undefined ? `已更新「${target.name}」` : '';
  const decide = async (source: BackendSource | null): Promise<void> => {
    const result = (await request({ type: MSG.SAVE_DECISION, source })) as { ok: boolean };
    if (source !== null) {
      flashStatus(
        result.ok ? (update ? updatedText : `已保存到 ${sourceLabel(source)}`) : '保存失败',
      );
    }
    container.remove();
  };

  for (const source of pending.decision.sources) {
    const label = `${update ? STRINGS.updateIn : STRINGS.saveTo} ${sourceLabel(source)}`;
    actions.append(actionButton(label, () => decide(source), true));
  }
  actions.append(actionButton(STRINGS.cancel, () => decide(null)));
  container.append(actions);
  resultsEl.prepend(container);
}

/** 仅 https 站点可申请授权（清单里的可选权限只覆盖 https）。 */
function originPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.host}/*`;
  } catch {
    return null;
  }
}

async function refreshSiteOptIn(): Promise<void> {
  const pattern = originPattern(pageUrl);
  if (pattern === null) {
    siteOptInBtn.hidden = true;
    return;
  }
  siteOptInBtn.hidden = false;
  siteGranted = await chrome.permissions.contains({ origins: [pattern] });
  siteOptInBtn.textContent = siteGranted ? STRINGS.siteOptInOn : STRINGS.siteOptInOff;
  siteOptInBtn.setAttribute('aria-pressed', String(siteGranted));
  siteOptInBtn.classList.toggle('active', siteGranted);
}

/** 对当前站点开启 / 关闭页面内填充：只申请这一个域名的访问权限（M-3）。 */
async function toggleSiteOptIn(): Promise<void> {
  const pattern = originPattern(pageUrl);
  if (pattern === null) return;
  if (siteGranted) {
    await chrome.permissions.remove({ origins: [pattern] });
    flashStatus(STRINGS.siteOptInOffDone);
  } else {
    // 必须在用户手势内调用，所以这里不做任何等待，直接申请
    const granted = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
    flashStatus(granted ? STRINGS.siteOptInOnDone : STRINGS.siteOptInDenied);
  }
  await refreshSiteOptIn();
}

async function refresh(): Promise<void> {
  const status = (await request({ type: MSG.STATUS })) as StatusResponse;
  setState(status);

  if (!status.anyReady) {
    // 两库都不可用。此时 KeePassXC 必然未配对（否则 anyReady 为 true）：
    // 直接在首页给出配对入口，而不是让用户自己去设置页找。
    contextRow.hidden = true;
    resultsEl.replaceChildren(
      actionBox(
        status.defaultFillSource === 'bitwarden' ? STRINGS.loginHint : STRINGS.pairHint,
        STRINGS.associate,
        () => associate(),
      ),
    );
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url) {
    contextRow.hidden = true;
    resultsEl.replaceChildren(stateBox(STRINGS.noTab));
    return;
  }
  pageUrl = tab.url;
  contextRow.hidden = false;
  try {
    siteHostEl.textContent = new URL(tab.url).hostname;
  } catch {
    siteHostEl.textContent = tab.url;
  }
  void refreshSiteOptIn();

  resultsEl.replaceChildren(stateBox(STRINGS.searching, true));
  const result = (await request({
    type: MSG.SEARCH,
    url: tab.url,
  })) as SearchView | null;

  resultsEl.replaceChildren();
  if (result === null) return;
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
    flashStatus('登录失败，请检查主密码或验证码');
    return;
  }
  await refresh();
}

async function selectSource(source: BackendSource): Promise<void> {
  await send(MSG.SET_DEFAULT_SOURCE, { source });
  await refresh();
}

/** 首页直接发起配对；失败原因按错误码转成用户能照做的提示。 */
async function associate(): Promise<void> {
  const result = (await request({ type: MSG.ASSOCIATE })) as {
    ok: boolean;
    code?: string;
  } | null;
  if (!result?.ok) {
    flashStatus(pairFailureText(result?.code));
    return;
  }
  flashStatus(STRINGS.paired);
  await refresh();
}

function pairFailureText(code: string | undefined): string {
  if (code === 'NETWORK_ERROR') return STRINGS.pairTimeout;
  if (code === 'NATIVE_PROXY_MISSING') return STRINGS.pairNoProxy;
  return STRINGS.pairFailed;
}

async function lock(): Promise<void> {
  await send(MSG.LOCK);
  await refresh();
}

byId('unlock').addEventListener('click', () => {
  void unlock();
});
sourceTabs.bitwarden.addEventListener('click', () => {
  void selectSource('bitwarden');
});
sourceTabs.keepassxc.addEventListener('click', () => {
  void selectSource('keepassxc');
});
lockBtn.addEventListener('click', () => {
  void lock();
});
siteOptInBtn.addEventListener('click', () => {
  void toggleSiteOptIn();
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
