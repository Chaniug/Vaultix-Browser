/** Options UI：只保存非敏感配置；主密码与派生密钥永不写入 storage.local（S-1）。 */
import { MSG } from '../shared/messages.js';
import { STRINGS } from './strings.js';

function valueOf(id: string): string {
  const element = document.getElementById(id);
  return element instanceof HTMLInputElement || element instanceof HTMLSelectElement
    ? element.value
    : '';
}

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element: ${id}`);
  return element;
}

function setValue(id: string, value: string): void {
  const element = byId(id);
  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
    element.value = value;
  }
}

function setChecked(id: string, value: boolean): void {
  const element = byId(id);
  if (element instanceof HTMLInputElement) element.checked = value;
}

function checkedOf(id: string): boolean {
  const element = document.getElementById(id);
  return element instanceof HTMLInputElement ? element.checked : false;
}

async function load(): Promise<void> {
  const stored = await chrome.storage.local.get([
    'serverUrl',
    'mode',
    'email',
    'lockPolicy',
    'defaultSaveSource',
    'autoFillOnLoad',
  ]);
  if (typeof stored.serverUrl === 'string') setValue('server-url', stored.serverUrl);
  if (stored.mode === 'bitwarden.cloud' || stored.mode === 'vaultwarden') {
    setValue('mode', stored.mode);
  }
  if (typeof stored.email === 'string') setValue('email', stored.email);
  // 锁定时长以 lockPolicy 为准：保存时写入的就是这个键
  if (typeof stored.lockPolicy === 'object' && stored.lockPolicy !== null) {
    const policy = stored.lockPolicy as Record<string, unknown>;
    if (typeof policy.backgroundLockMs === 'number') {
      setValue('background-lock', String(policy.backgroundLockMs / 60_000));
    }
    if (typeof policy.idleLockMs === 'number') {
      setValue('idle-lock', String(policy.idleLockMs / 60_000));
    }
  }
  if (stored.defaultSaveSource === 'bitwarden' || stored.defaultSaveSource === 'keepassxc') {
    setValue('default-save-source', stored.defaultSaveSource);
  }
  // 未设置过时默认开启（后台用的是同一套默认值）
  setChecked('auto-fill-on-load', stored.autoFillOnLoad !== false);
  await renderSites();
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function toast(text: string, error = false): void {
  const el = byId('saved');
  if (toastTimer !== null) clearTimeout(toastTimer);
  el.textContent = text;
  el.className = error ? 'toast show error' : 'toast show';
  toastTimer = setTimeout(() => {
    el.className = 'toast';
    el.textContent = '';
    toastTimer = null;
  }, 2600);
}

async function save(): Promise<void> {
  const mode = valueOf('mode') === 'vaultwarden' ? 'vaultwarden' : 'bitwarden.cloud';
  const backgroundMinutes = Number(valueOf('background-lock')) || 5;
  const idleMinutes = Number(valueOf('idle-lock')) || 15;
  try {
    await chrome.storage.local.set({
      serverUrl: valueOf('server-url'),
      mode,
      email: valueOf('email'),
      defaultSaveSource: valueOf('default-save-source') === 'keepassxc' ? 'keepassxc' : 'bitwarden',
      lockPolicy: {
        backgroundLockMs: backgroundMinutes * 60_000,
        idleLockMs: idleMinutes * 60_000,
      },
      autoFillOnLoad: checkedOf('auto-fill-on-load'),
    });
    toast(STRINGS.saved);
  } catch {
    toast('保存失败', true);
  }
}

function serverOrigin(): string {
  const raw = valueOf('server-url');
  if (raw.length === 0) return '';
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
}

/**
 * 列出「页面内填充」已授权的站点。密码库服务端地址也会出现在可选权限里（登录需要），
 * 但撤销它会直接导致无法登录，所以从列表中排除。
 */
async function renderSites(): Promise<void> {
  const list = byId('site-list');
  const granted = await chrome.permissions.getAll();
  const vault = serverOrigin();
  const origins = (granted.origins ?? [])
    .filter((origin) => origin.startsWith('https://'))
    .map((origin) => origin.replace(/\/\*$/, ''))
    .filter((origin) => origin !== vault);

  list.replaceChildren();
  if (origins.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = '还没有启用任何站点';
    list.append(empty);
    return;
  }
  for (const origin of origins) {
    const row = document.createElement('div');
    row.className = 'site-row';
    const name = document.createElement('span');
    name.className = 'site-origin';
    name.textContent = origin;
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'ghost-btn';
    revoke.textContent = '撤销';
    revoke.addEventListener('click', () => {
      void (async () => {
        await chrome.permissions.remove({ origins: [`${origin}/*`] });
        await renderSites();
      })();
    });
    row.append(name, revoke);
    list.append(row);
  }
}

async function associate(): Promise<void> {
  const statusEl = byId('association-status');
  statusEl.textContent = '正在配对…请在 KeePassXC 弹窗里点「允许」';
  try {
    const result = (await chrome.runtime.sendMessage({ type: MSG.ASSOCIATE })) as {
      ok: boolean;
      code?: string;
    } | null;
    if (result?.ok) {
      statusEl.textContent = '✓ 配对成功';
      return;
    }
    statusEl.textContent =
      result?.code === 'NETWORK_ERROR'
        ? STRINGS.pairTimeout
        : result?.code === 'NATIVE_PROXY_MISSING'
          ? STRINGS.pairNoProxy
          : STRINGS.pairFailed;
  } catch {
    statusEl.textContent = STRINGS.pairFailed;
  }
}

byId('save').addEventListener('click', () => {
  void save();
});
byId('associate').addEventListener('click', () => {
  void associate();
});

chrome.permissions.onAdded.addListener(() => {
  void renderSites();
});
chrome.permissions.onRemoved.addListener(() => {
  void renderSites();
});

void load();
