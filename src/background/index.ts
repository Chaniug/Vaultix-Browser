/**
 * Service Worker：唯一装配点（E-2）。
 * 创建适配器 → 注入合并器 → 向 UI 提供统一结果；不直接操作 DOM。
 *
 * 统一填充服务在这里：popup 按钮与页面内浮层都只发「来源 + 条目 + 字段」，
 * 真实的用户名 / 密码 / 即时验证码只在这一处取出，UI 层不持有明文。
 */
import { searchAcrossBackends } from '../core/merger.js';
import { buildFillPlan, resolveTotpCode, type FillField } from '../core/fill.js';
import { DEFAULT_LOCK_POLICY, isLockSnapshot, LockManager } from '../core/lock-manager.js';
import type { LockPolicy } from '../core/lock-manager.js';
import { coerceDraft, decideSaveAction } from '../core/save.js';
import { toSearchView, type SearchView } from '../core/suggest.js';
import type {
  BackendAdapter,
  BackendSource,
  CredentialDraft,
  CredentialItem,
  SaveResult,
} from '../core/types.js';
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
import { ERROR_CODES, toErrorCode } from '../shared/errors.js';
import { logDebug, logWarn } from '../shared/logger.js';
import { redactDomain } from '../shared/url.js';
import {
  isRuntimeMessage,
  MSG,
  type FillItemMessage,
  type FillItemResponse,
  type PageSuggestionsMessage,
  type PageSuggestionsResponse,
  type SaveCheckResponse,
  type StatusResponse,
} from '../shared/messages.js';

interface StoredSettings {
  readonly serverUrl?: string;
  readonly mode?: BitwardenMode;
  readonly email?: string;
  readonly association?: KeePassAssociation | null;
  readonly lockPolicy?: LockPolicy;
  readonly defaultFillSource?: BackendSource;
  readonly defaultSaveSource?: BackendSource;
  readonly autoFillOnLoad?: boolean;
}

interface PendingSave {
  readonly draft: CredentialDraft;
  readonly decision: SaveCheckResponse;
  readonly at: number;
}

const SETTINGS_KEYS = [
  'serverUrl',
  'mode',
  'email',
  'association',
  'lockPolicy',
  'defaultFillSource',
  'defaultSaveSource',
  'autoFillOnLoad',
];
const OFFSCREEN_URL = 'ui/offscreen.html';
/**
 * 配对（associate）需要用户在 KeePassXC 弹窗里点「允许」，而该弹窗常出现在浏览器后面；
 * 通行密钥还可能在 KeePassXC 里等待用户选择条目。因此统一放宽到 90 秒。
 */
const KEEPASS_TIMEOUT_MS = 90_000;
const CLIPBOARD_TTL_MS = 30_000;
/** 暂存的保存草稿只在短时间内有效：避免很久之后在无关页面上突然问"要保存吗" */
const PENDING_SAVE_TTL_MS = 90_000;
/** 按站点注册的内容脚本：用户在 popup 里对某个站点开启页面内填充后才会注入（M-3） */
/** 锁定计时的会话态：chrome.storage.session（内存态），service worker 回收后据此续算 */
const LOCK_SESSION_KEY = 'lockSession';
/** 活动时间戳的落盘节流：丢几秒精度无妨，避免频繁写 storage */
const LOCK_PERSIST_INTERVAL_MS = 30_000;
const IN_PAGE_SCRIPT_FILE = 'content/content.js';
const PASSKEY_SCRIPT_FILE = 'content/passkeys.js';
/**
 * 按站点注册的两段脚本：
 *  - 内容脚本（隔离世界）负责填充浮层与消息中继；
 *  - 通行密钥提供方必须跑在页面主世界，才能真正接管 navigator.credentials，
 *    并且在 document_start 装入，避免站点在加载时就调用 WebAuthn 而错过。
 */
const IN_PAGE_SCRIPTS = [
  { id: 'vaultix-in-page', js: [IN_PAGE_SCRIPT_FILE], runAt: 'document_idle', world: 'ISOLATED' },
  { id: 'vaultix-passkeys', js: [PASSKEY_SCRIPT_FILE], runAt: 'document_start', world: 'MAIN' },
] as const;

let settings: StoredSettings = {};
let bitwarden: BitwardenAdapter | null = null;
let keepass: KeePassRpcAdapter | null = null;
let lockManager: LockManager | null = null;
/**
 * 待用户确认的保存草稿。存 chrome.storage.session（内存态，浏览器关闭即失效），
 * 这样即使 service worker 在整页跳转期间被回收，下一页仍能接着提示（S-1 允许的会话态）。
 */
let pendingSave: PendingSave | null = null;
let lastLockPersist = 0;

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
    ...(stored.defaultFillSource === 'bitwarden' || stored.defaultFillSource === 'keepassxc'
      ? { defaultFillSource: stored.defaultFillSource }
      : {}),
    ...(stored.defaultSaveSource === 'bitwarden' || stored.defaultSaveSource === 'keepassxc'
      ? { defaultSaveSource: stored.defaultSaveSource }
      : {}),
    ...(typeof stored.autoFillOnLoad === 'boolean'
      ? { autoFillOnLoad: stored.autoFillOnLoad }
      : {}),
  };
  lockManager = new LockManager(settings.lockPolicy ?? DEFAULT_LOCK_POLICY);
  // service worker 被回收后恢复计时；否则每次回收都从零开始，超时策略等于不存在
  const sessionState = await chrome.storage.session.get([LOCK_SESSION_KEY]);
  if (isLockSnapshot(sessionState.lockSession)) lockManager.restore(sessionState.lockSession);
}

async function persistLock(force = false): Promise<void> {
  if (lockManager === null) return;
  const now = Date.now();
  if (!force && now - lastLockPersist < LOCK_PERSIST_INTERVAL_MS) return;
  lastLockPersist = now;
  await chrome.storage.session.set({ lockSession: lockManager.snapshot() });
}

/**
 * 懒评估锁定超时：不依赖定时器（MV3 里 timer 不可靠，也不值得为它申请 alarms 权限），
 * 每次处理消息、窗口焦点变化时检查一次。超时即销毁 Bitwarden 会话；KeePassXC 不受影响
 * （它由桌面端自己管理解锁状态）。
 */
async function evaluateLock(): Promise<void> {
  if (lockManager === null) return;
  const before = lockManager.getState();
  if (lockManager.tick() === before) return;
  if (before === 'unlocked') {
    bitwarden?.lock();
    await chrome.storage.session.remove(['bitwardenSession']);
    logDebug('background.lock.expired', { ok: true });
  }
  await persistLock(true);
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

function asSource(value: unknown): BackendSource | null {
  return value === 'bitwarden' || value === 'keepassxc' ? value : null;
}

function isFillField(value: unknown): value is FillField {
  return value === 'username' || value === 'password' || value === 'totp';
}

async function ensureAdapters(): Promise<readonly BackendAdapter[]> {
  const adapters: BackendAdapter[] = [];
  if (!keepass) {
    keepass = createKeePassRpcAdapter({
      association: settings.association ?? null,
      timeoutMs: KEEPASS_TIMEOUT_MS,
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

/** 首页选中的默认填充库排在前，另一库兜底 */
function fillPriority(): readonly BackendSource[] {
  const primary = settings.defaultFillSource ?? 'bitwarden';
  return [primary, primary === 'bitwarden' ? 'keepassxc' : 'bitwarden'];
}

/** 当前可以写入的来源；默认保存目标排第一 */
function writableSources(adapters: readonly BackendAdapter[]): readonly BackendSource[] {
  const preferred = settings.defaultSaveSource ?? 'bitwarden';
  return adapters
    .filter((adapter) => adapter.capabilities.write && adapter.isReady())
    .map((adapter) => adapter.source)
    .sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));
}

async function searchItems(url: string): Promise<readonly CredentialItem[]> {
  const adapters = await ensureAdapters();
  return (await searchAcrossBackends(adapters, { url }, fillPriority())).items;
}

/** 发起方所在 frame 的地址优先；iframe 里没有匹配时再按标签页顶层地址试一次 */
function candidateUrls(frameUrl: unknown, sender: ChromeMessageSender): readonly string[] {
  const urls = [frameUrl, sender.tab?.url].filter(
    (url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url),
  );
  return [...new Set(urls)];
}

async function findItem(
  urls: readonly string[],
  source: BackendSource,
  id: string,
): Promise<CredentialItem | null> {
  for (const url of urls) {
    const items = await searchItems(url);
    const found = items.find((item) => item.source === source && item.id === id);
    if (found !== undefined) return found;
  }
  return null;
}

function statusResponse(): StatusResponse {
  const bwReady = bitwarden?.isReady() ?? false;
  const kpReady = keepass?.isReady() ?? false;
  return {
    state: lockManager?.getState() ?? 'locked',
    bitwardenReady: bwReady,
    bitwardenConfigured: Boolean(settings.serverUrl && settings.email),
    keepassReady: kpReady,
    needsAssociation: keepass !== null && !kpReady,
    anyReady: bwReady || kpReady,
    canWrite:
      (bitwarden?.capabilities.write === true && bwReady) ||
      (keepass?.capabilities.write === true && kpReady),
    defaultFillSource: settings.defaultFillSource ?? 'bitwarden',
    defaultSaveSource: settings.defaultSaveSource ?? 'bitwarden',
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
      files: [IN_PAGE_SCRIPT_FILE],
    });
    // 通行密钥提供方必须注入页面主世界（该上下文没有扩展 API）
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [PASSKEY_SCRIPT_FILE],
      world: 'MAIN',
    });
  } catch {
    // 权限未授予或页面不支持注入：静默跳过，不向用户泄露错误细节
    logWarn('content.inject.failed', { code: toErrorCode(undefined) });
  }
}

/**
 * 按站点授权（M-3）：把内容脚本注册到「用户已授权的站点」上。
 * 不申请全站通配权限——用户在 popup 里对某个站点点一次「本站启用」，才在该站点自动生效。
 */
async function syncInPageScripts(): Promise<void> {
  const granted = await chrome.permissions.getAll();
  const matches = (granted.origins ?? []).filter((origin) => origin.startsWith('https://'));
  const registeredIds = new Set(
    (await chrome.scripting.getRegisteredContentScripts()).map((script) => script.id),
  );

  for (const script of IN_PAGE_SCRIPTS) {
    const registered = registeredIds.has(script.id);
    if (matches.length === 0) {
      if (registered) await chrome.scripting.unregisterContentScripts({ ids: [script.id] });
      continue;
    }
    if (registered) {
      await chrome.scripting.updateContentScripts([{ id: script.id, matches }]);
      continue;
    }
    await chrome.scripting.registerContentScripts([
      {
        id: script.id,
        matches,
        js: [...script.js],
        runAt: script.runAt,
        world: script.world,
        allFrames: true,
      },
    ]);
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

/** 复制到剪贴板并定时清空（S-5） */
async function copyToClipboard(text: string): Promise<void> {
  await ensureOffscreen();
  await chrome.runtime.sendMessage({ type: MSG.COPY, text, ttlMs: CLIPBOARD_TTL_MS });
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
    await persistLock(true);
    return { ok: true };
  } catch (error) {
    logWarn('background.unlock.failed', { code: toErrorCode(error) });
    return { ok: false };
  }
}

/** 给 popup 的候选：只有显示所需字段，不含密码 */
async function handleSearch(url: unknown): Promise<SearchView> {
  if (typeof url !== 'string') return { items: [], ambiguous: false };
  const started = Date.now();
  const items = await searchItems(url);
  logDebug('background.search', {
    ok: items.length > 0,
    durationMs: Date.now() - started,
  });
  return toSearchView(items);
}

async function handlePageSuggestions(
  raw: PageSuggestionsMessage,
  sender: ChromeMessageSender,
): Promise<PageSuggestionsResponse> {
  const urls = candidateUrls(raw.url, sender);
  let items: readonly CredentialItem[] = [];
  for (const url of urls) {
    items = await searchItems(url);
    if (items.length > 0) break;
  }
  const adapters = await ensureAdapters();
  return {
    ...toSearchView(items),
    autoFillOnLoad: settings.autoFillOnLoad !== false,
    anyReady: adapters.length > 0,
  };
}

/** 即时验证码：KeePassXC 现取（会过期）；Bitwarden 由种子算出 */
async function fetchFreshTotp(item: CredentialItem, wanted: boolean): Promise<string | undefined> {
  if (!wanted || item.source !== 'keepassxc') return undefined;
  return keepass?.getTotp(item.id);
}

async function handleFillItem(
  raw: FillItemMessage,
  sender: ChromeMessageSender,
): Promise<FillItemResponse> {
  const source = asSource(raw.source);
  if (source === null || typeof raw.id !== 'string' || typeof raw.url !== 'string') {
    return { ok: false, code: ERROR_CODES.UNKNOWN };
  }
  const fields = raw.fields.filter(isFillField);
  const item = await findItem(candidateUrls(raw.url, sender), source, raw.id);
  if (item === null) return { ok: false, code: ERROR_CODES.BACKEND_NOT_READY };

  const fresh = await fetchFreshTotp(item, fields.includes('totp'));
  const plan = await buildFillPlan(item, fields, fresh !== undefined ? { freshTotp: fresh } : {});
  if (Object.keys(plan).length === 0) return { ok: false, filled: 0 };
  if (raw.copyTotp && plan.totp !== undefined) await copyToClipboard(plan.totp);

  // 内容脚本发起：把计划交回给它，在它自己的 frame 里写入
  if (sender.tab?.id !== undefined) return { ok: true, plan };

  // popup 发起：下发给当前标签页，不回传明文
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) return { ok: false };
  await injectContentScript();
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: MSG.FILL, plan });
    const filled = typeof response.filled === 'number' ? response.filled : 0;
    return { ok: filled > 0, filled };
  } catch {
    // 页面不支持注入（浏览器内部页、应用商店等）
    return { ok: false, filled: 0, code: ERROR_CODES.UNKNOWN };
  }
}

async function handleCopyItem(raw: unknown, sender: ChromeMessageSender): Promise<{ ok: boolean }> {
  if (typeof raw !== 'object' || raw === null) return { ok: false };
  const request = raw as Record<string, unknown>;
  const source = asSource(request.source);
  if (
    source === null ||
    typeof request.id !== 'string' ||
    typeof request.url !== 'string' ||
    (request.kind !== 'password' && request.kind !== 'totp')
  ) {
    return { ok: false };
  }
  const item = await findItem(candidateUrls(request.url, sender), source, request.id);
  if (item === null) return { ok: false };
  if (request.kind === 'password') {
    await copyToClipboard(item.password);
    return { ok: true };
  }
  const fresh = await fetchFreshTotp(item, true);
  const code = await resolveTotpCode(item.totp, fresh !== undefined ? { freshTotp: fresh } : {});
  if (code === undefined || code.length === 0) return { ok: false };
  await copyToClipboard(code);
  return { ok: true };
}

// ---------- 保存草稿 ----------

function parseSaveDecision(value: unknown): SaveCheckResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.action !== 'create' && candidate.action !== 'update') return null;
  const sources = Array.isArray(candidate.sources)
    ? candidate.sources.filter((source): source is BackendSource => asSource(source) !== null)
    : [];
  if (sources.length === 0) return null;
  if (candidate.action === 'create') return { action: 'create', sources };

  const rawTarget = candidate.target;
  if (typeof rawTarget !== 'object' || rawTarget === null) return null;
  const target = rawTarget as Record<string, unknown>;
  const source = asSource(target.source);
  if (
    source === null ||
    typeof target.id !== 'string' ||
    typeof target.name !== 'string' ||
    typeof target.username !== 'string'
  ) {
    return null;
  }
  return {
    action: 'update',
    target: { source, id: target.id, name: target.name, username: target.username },
    sources,
  };
}

async function setPendingSave(next: PendingSave | null): Promise<void> {
  pendingSave = next;
  if (next === null) await chrome.storage.session.remove(['pendingSave']);
  else await chrome.storage.session.set({ pendingSave: next });
}

async function currentPendingSave(): Promise<PendingSave | null> {
  if (pendingSave === null) {
    const stored = await chrome.storage.session.get(['pendingSave']);
    const record = stored.pendingSave;
    if (typeof record !== 'object' || record === null) return null;
    const candidate = record as Record<string, unknown>;
    const draft = coerceDraft(candidate.draft);
    const decision = parseSaveDecision(candidate.decision);
    if (draft === null || decision === null || typeof candidate.at !== 'number') return null;
    pendingSave = { draft, decision, at: candidate.at };
  }
  if (Date.now() - pendingSave.at > PENDING_SAVE_TTL_MS) {
    await setPendingSave(null);
    return null;
  }
  return pendingSave;
}

async function evaluateSaveCandidate(value: unknown): Promise<SaveCheckResponse> {
  const draft = coerceDraft(value);
  if (draft === null) return { action: 'none', sources: [] };
  const adapters = await ensureAdapters();
  const items = await searchItems(draft.url);
  const decision = decideSaveAction(items, draft, writableSources(adapters));
  if (decision.action !== 'none') {
    await setPendingSave({ draft, decision, at: Date.now() });
  }
  logDebug('background.save.check', { ok: decision.action !== 'none' });
  return decision;
}

async function handleSaveDecision(
  source: BackendSource | null,
): Promise<SaveResult | { ok: false }> {
  const pending = await currentPendingSave();
  if (source === null) {
    if (pending !== null) await setPendingSave(null);
    return { ok: false };
  }
  if (pending === null || !pending.decision.sources.includes(source)) return { ok: false };

  const adapters = await ensureAdapters();
  const adapter = adapters.find((item) => item.source === source && item.capabilities.write);
  if (adapter === undefined) return { ok: false };

  const target = pending.decision.target;
  const draft =
    target !== undefined && target.source === source
      ? { ...pending.draft, uuid: target.id }
      : pending.draft;
  const result = await adapter.save(draft);
  if (result.ok) await setPendingSave(null);
  return result;
}

// ---------- 通行密钥 ----------

function senderOrigin(sender: ChromeMessageSender): string | null {
  const raw = sender.url ?? sender.tab?.url;
  if (typeof raw !== 'string') return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** 只做形状校验：真正的合法性校验在 KeePassXC 里（域名 / challenge 长度 / 算法等） */
function isPasskeyOptionsValid(
  value: unknown,
  kind: 'register' | 'get',
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const options = value as Record<string, unknown>;
  const challenge = options.challenge;
  if (typeof challenge !== 'string' || challenge.length < 16 || challenge.length > 512)
    return false;
  if (kind === 'register') {
    const user = options.user;
    if (typeof user !== 'object' || user === null) return false;
    const id = (user as Record<string, unknown>).id;
    if (typeof id !== 'string' || id.length === 0) return false;
  }
  try {
    return JSON.stringify(options).length <= 64 * 1024;
  } catch {
    return false;
  }
}

async function handlePasskey(
  kind: 'register' | 'get',
  options: unknown,
  sender: ChromeMessageSender,
): Promise<{
  ok: boolean;
  fallback?: boolean;
  credential?: Record<string, unknown>;
  errorCode?: number;
}> {
  // 只接受来自内容脚本（页面）的请求；扩展页面自己发起没有意义
  if (sender.tab === undefined) return { ok: false, fallback: true };
  const origin = senderOrigin(sender);
  if (origin === null || !isPasskeyOptionsValid(options, kind))
    return { ok: false, fallback: true };

  await ensureAdapters();
  if (keepass === null || !keepass.supportsPasskeys()) return { ok: false, fallback: true };

  try {
    const payload =
      kind === 'register'
        ? await keepass.passkeysRegister(options, origin)
        : await keepass.passkeysGet(options, origin);
    const rawCode = payload.errorCode;
    if (rawCode !== undefined) {
      const code = typeof rawCode === 'number' ? rawCode : Number(rawCode);
      logWarn('background.passkey.failed', { backend: 'keepassxc', code: toErrorCode(undefined) });
      return { ok: false, errorCode: Number.isFinite(code) ? code : 31 };
    }
    return { ok: true, credential: payload };
  } catch (error) {
    logWarn('background.passkey.failed', { backend: 'keepassxc', code: toErrorCode(error) });
    return { ok: false, errorCode: 31 };
  }
}

// ---------- 消息分发 ----------

/**
 * service worker 冷启动后的第一条消息，必须等配置读完再处理：
 * 否则适配器会在「没读到配对信息」的状态下被创建，之后整个生命周期都显示未连接。
 */
const settingsReady = loadSettings().catch((error: unknown) => {
  logWarn('background.settings.failed', { code: toErrorCode(error) });
});

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  if (!isRuntimeMessage(raw)) return false;

  void (async () => {
    try {
      await settingsReady;
      // 先判定是否已超时（超时就作废会话），再把本次请求记为活动
      await evaluateLock();
      if (raw.type !== MSG.LOCK) {
        lockManager?.handle('ACTIVITY');
        void persistLock();
      }
      switch (raw.type) {
        case MSG.STATUS:
          await ensureAdapters();
          await injectContentScript();
          sendResponse(statusResponse());
          break;
        case MSG.UNLOCK:
          sendResponse(await handleUnlock(raw));
          break;
        case MSG.SET_DEFAULT_SOURCE:
          settings = { ...settings, defaultFillSource: raw.source };
          await chrome.storage.local.set({ defaultFillSource: raw.source });
          sendResponse({ ok: true });
          break;
        case MSG.LOCK:
          bitwarden?.lock();
          await chrome.storage.session.remove(['bitwardenSession']);
          lockManager?.handle('LOCK');
          await persistLock(true);
          sendResponse({ ok: true });
          break;
        case MSG.SEARCH:
          sendResponse(await handleSearch(raw.url));
          break;
        case MSG.PAGE_SUGGESTIONS:
          sendResponse(await handlePageSuggestions(raw, sender));
          break;
        case MSG.FILL_ITEM:
          sendResponse(await handleFillItem(raw, sender));
          break;
        case MSG.COPY_ITEM:
          sendResponse(await handleCopyItem(raw, sender));
          break;
        case MSG.PASSKEY_AVAILABLE:
          await ensureAdapters();
          sendResponse({ available: keepass?.supportsPasskeys() === true });
          break;
        case MSG.PASSKEY_REGISTER:
          sendResponse(await handlePasskey('register', raw.options, sender));
          break;
        case MSG.PASSKEY_GET:
          sendResponse(await handlePasskey('get', raw.options, sender));
          break;
        case MSG.ASSOCIATE: {
          if (!keepass) {
            keepass = createKeePassRpcAdapter({
              association: settings.association ?? null,
              timeoutMs: KEEPASS_TIMEOUT_MS,
            });
          }
          // 配对失败不抛到外层：把错误码带回 UI，让用户知道是超时还是通道问题
          try {
            const association = await keepass.associate();
            settings = { ...settings, association };
            await chrome.storage.local.set({ association });
            sendResponse({ ok: true });
          } catch (error) {
            const code = toErrorCode(error);
            logWarn('background.associate.failed', { backend: 'keepassxc', code });
            sendResponse({ ok: false, code });
          }
          break;
        }
        case MSG.SAVE_CANDIDATE:
          sendResponse(await evaluateSaveCandidate(raw.draft));
          break;
        case MSG.PENDING_SAVE: {
          const pending = await currentPendingSave();
          sendResponse(
            pending === null
              ? null
              : {
                  username: pending.draft.username,
                  host: redactDomain(pending.draft.url),
                  decision: pending.decision,
                },
          );
          break;
        }
        case MSG.SAVE_DECISION:
          sendResponse(await handleSaveDecision(raw.source));
          break;
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

// 站点授权变化（用户在 popup 里开关，或在浏览器扩展页里改"站点访问权限"）时同步内容脚本注册
const syncInPage = (): void => {
  void syncInPageScripts().catch((error: unknown) => {
    logWarn('background.inpage.sync.failed', { code: toErrorCode(error) });
  });
};
chrome.permissions.onAdded.addListener(syncInPage);
chrome.permissions.onRemoved.addListener(syncInPage);
void settingsReady.then(syncInPage);

// 窗口失去 / 获得焦点：后台锁定计时靠它，否则"切到别的应用 5 分钟后锁定"无法判定
try {
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (lockManager === null) return;
    if (windowId === chrome.windows.WINDOW_ID_NONE) lockManager.enterBackground();
    else lockManager.handle('RESUME');
    void persistLock(true);
  });
} catch (error) {
  logWarn('background.focus.unavailable', { code: toErrorCode(error) });
}
