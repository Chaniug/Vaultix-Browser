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

async function load(): Promise<void> {
  const stored = await chrome.storage.local.get([
    'serverUrl',
    'mode',
    'email',
    'backgroundLockMs',
    'idleLockMs',
    'defaultSaveSource',
  ]);
  if (typeof stored.serverUrl === 'string') setValue('server-url', stored.serverUrl);
  if (stored.mode === 'bitwarden.cloud' || stored.mode === 'vaultwarden') {
    setValue('mode', stored.mode);
  }
  if (typeof stored.email === 'string') setValue('email', stored.email);
  if (typeof stored.backgroundLockMs === 'number') {
    setValue('background-lock', String(stored.backgroundLockMs / 60_000));
  }
  if (typeof stored.idleLockMs === 'number') {
    setValue('idle-lock', String(stored.idleLockMs / 60_000));
  }
  if (stored.defaultSaveSource === 'bitwarden' || stored.defaultSaveSource === 'keepassxc') {
    setValue('default-save-source', stored.defaultSaveSource);
  }
}

async function save(): Promise<void> {
  const mode = valueOf('mode') === 'vaultwarden' ? 'vaultwarden' : 'bitwarden.cloud';
  const backgroundMinutes = Number(valueOf('background-lock')) || 5;
  const idleMinutes = Number(valueOf('idle-lock')) || 15;
  await chrome.storage.local.set({
    serverUrl: valueOf('server-url'),
    mode,
    email: valueOf('email'),
    defaultSaveSource: valueOf('default-save-source') === 'keepassxc' ? 'keepassxc' : 'bitwarden',
    lockPolicy: {
      backgroundLockMs: backgroundMinutes * 60_000,
      idleLockMs: idleMinutes * 60_000,
    },
  });
  byId('saved').textContent = STRINGS.saved;
}

async function associate(): Promise<void> {
  const result = (await chrome.runtime.sendMessage({ type: MSG.ASSOCIATE })) as {
    ok: boolean;
  };
  byId('association-status').textContent = result.ok
    ? '配对成功'
    : '配对失败，请确认 KeePassXC 已运行';
}

byId('save').addEventListener('click', () => {
  void save();
});
byId('associate').addEventListener('click', () => {
  void associate();
});

void load();
