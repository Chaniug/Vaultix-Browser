/**
 * Service Worker：唯一装配点（E-2）。
 * 创建适配器 → 注入合并器 → 向 UI 提供统一结果；不直接操作 DOM。
 */
import { searchAcrossBackends } from '../core/merger.js';
import type { BackendAdapter, SearchQuery } from '../core/types.js';
import { DEFAULT_LOCK_POLICY, LockManager } from '../core/lock-manager.js';
import type { LockPolicy } from '../core/lock-manager.js';
import {
  createBitwardenAdapter,
  type BitwardenAdapter,
  type BitwardenMode,
} from '../adapters/bitwarden/index.js';
import {
  createKeePassRpcAdapter,
  type KeePassAssociation,
  type KeePassRpcAdapter,
} from '../adapters/keepassrpc/index.js';
import { toErrorCode } from '../shared/errors.js';
import { logDebug, logWarn } from '../shared/logger.js';
import { isRuntimeMessage, MSG, type StatusResponse } from '../shared/messages.js';

interface StoredSettings {
  readonly serverUrl?: string;
  readonly mode?: BitwardenMode;
  readonly email?: string;
  readonly association?: KeePassAssociation | null;
  readonly lockPolicy?: LockPolicy;
}

const SETTINGS_KEYS = ['serverUrl', 'mode', 'email', 'association', 'lockPolicy'];
const OFFSCREEN_URL = 'ui/offscreen.html';

let settings: StoredSettings = {};
let bitwarden: BitwardenAdapter | null = null;
let keepass: KeePassRpcAdapter | null = null;
let lockManager: LockManager | null = null;

async function loadSettings(): Promise<void> {
  const stored = await chrome.storage.local.get([...SETTINGS_KEYS]);
  settings = {
    ...(typeof stored.serverUrl === 'string' ? { serverUrl: stored.serverUrl } : {}),
    ...(stored.mode === 'bitwarden.cloud' || stored.mode === 'vaultwarden'
      ? { mode: stored.mode }
      : {}),
    ...(typeof stored.email === 'string' ? { email: stored.email } : {}),
    ...(isAssociation(stored.association) ? { association: stored.association } : {}),
    ...(isLockPolicy(stored.lockPolicy) ? { lockPolicy: stored.lockPolicy } : {}),
  };
  lockManager = new LockManager(settings.lockPolicy ?? DEFAULT_LOCK_POLICY);
}

function isAssociation(value: unknown): value is KeePassAssociation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && typeof candidate.key === 'string';
}

function isLockPolicy(value: unknown): value is LockPolicy {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.backgroundLockMs === 'number' && typeof candidate.idleLockMs === 'number';
}

async function ensureAdapters(): Promise<readonly BackendAdapter[]> {
  const adapters: BackendAdapter[] = [];
  if (!keepass) {
    keepass = createKeePassRpcAdapter({
      association: settings.association ?? null,
    });
    await keepass.initialize();
  }
  if (keepass.isReady()) adapters.push(keepass);

  const snapshot = await chrome.storage.session.get(['bitwardenSession']);
  const stored = snapshot.bitwardenSession;
  if (!bitwarden && isSessionSnapshot(stored)) {
    bitwarden = createBitwardenAdapter({
      serverUrl: settings.serverUrl ?? 'https://vault.bitwarden.com',
      mode: settings.mode ?? 'bitwarden.cloud',
      ...(settings.email !== undefined ? { email: settings.email } : {}),
      accessToken: stored.accessToken,
      symmetricKey: stored.symmetricKey,
      ...(stored.refreshToken !== undefined ? { refreshToken: stored.refreshToken } : {}),
    });
  }
  if (bitwarden?.isReady()) adapters.push(bitwarden);
  return adapters;
}

function isSessionSnapshot(value: unknown): value is {
  readonly accessToken: string;
  readonly symmetricKey: string;
  readonly refreshToken?: string;
} {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.accessToken === 'string' && typeof candidate.symmetricKey === 'string';
}

function statusResponse(): StatusResponse {
  return {
    state: lockManager?.getState() ?? 'locked',
    bitwardenReady: bitwarden?.isReady() ?? false,
    keepassReady: keepass?.isReady() ?? false,
    needsAssociation: keepass !== null && !keepass.isReady(),
  };
}

async function injectContentScript(): Promise<void> {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (tab?.id === undefined || !tab.url?.startsWith('http')) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content.js'],
    });
  } catch {
    // 权限未授予或页面不支持注入：静默跳过，不向用户泄露错误细节
    logWarn('content.inject.failed', { code: toErrorCode(undefined) });
  }
}

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['CLIPBOARD'],
    justification: '定时清空剪贴板中的一次性凭证',
  });
}

async function handleUnlock(message: {
  readonly masterPassword?: string;
  readonly twoFactorCode?: string;
}): Promise<{ ok: boolean }> {
  if (!settings.serverUrl || !settings.email || !message.masterPassword) {
    return { ok: false };
  }
  try {
    bitwarden = createBitwardenAdapter({
      serverUrl: settings.serverUrl,
      mode: settings.mode ?? 'bitwarden.cloud',
      email: settings.email,
      masterPassword: message.masterPassword,
      ...(message.twoFactorCode !== undefined ? { twoFactorCode: message.twoFactorCode } : {}),
    });
    await bitwarden.login();
    const snapshot = bitwarden.exportSession();
    if (snapshot) {
      await chrome.storage.session.set({ bitwardenSession: snapshot });
    }
    lockManager?.handle('UNLOCK');
    return { ok: true };
  } catch (error) {
    logWarn('background.unlock.failed', { code: toErrorCode(error) });
    return { ok: false };
  }
}

async function handleSearch(query: SearchQuery): Promise<ReturnType<typeof searchAcrossBackends>> {
  if (!lockManager?.isUnlocked()) {
    return { items: [], ambiguous: false };
  }
  const adapters = await ensureAdapters();
  const started = Date.now();
  const result = await searchAcrossBackends(adapters, query);
  logDebug('background.search', {
    ok: result.items.length > 0,
    durationMs: Date.now() - started,
  });
  return result;
}

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  if (!isRuntimeMessage(raw)) return false;

  void (async () => {
    try {
      switch (raw.type) {
        case MSG.STATUS:
          await injectContentScript();
          sendResponse(statusResponse());
          break;
        case MSG.UNLOCK:
          sendResponse(await handleUnlock(raw));
          break;
        case MSG.LOCK:
          bitwarden?.lock();
          await chrome.storage.session.remove(['bitwardenSession']);
          lockManager?.handle('LOCK');
          sendResponse({ ok: true });
          break;
        case MSG.SEARCH:
          sendResponse(await handleSearch(raw.query));
          break;
        case MSG.ASSOCIATE: {
          if (!keepass) keepass = createKeePassRpcAdapter({});
          const association = await keepass.associate();
          await chrome.storage.local.set({ association });
          sendResponse({ ok: true });
          break;
        }
        case MSG.FILL: {
          const [tab] = await chrome.tabs.query({
            active: true,
            lastFocusedWindow: true,
          });
          if (tab?.id !== undefined) {
            await chrome.tabs.sendMessage(tab.id, raw);
          }
          sendResponse({ ok: true });
          break;
        }
        case MSG.COPY:
          await ensureOffscreen();
          await chrome.runtime.sendMessage(raw);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse(null);
      }
    } catch (error) {
      logWarn('background.message.failed', { code: toErrorCode(error) });
      sendResponse(null);
    }
  })();
  return true;
});

void loadSettings();
