/**
 * Content script 入口：只做字段识别与填充，不接触后端适配器（E-2 / S-4）。
 * 所有需要凭证的操作都只向 background 发「来源 + 条目 + 字段」，不在页面侧持有密码。
 */
import type { FillPlan } from '../core/fill.js';
import type { BackendSource, SaveResult } from '../core/types.js';
import {
  isRuntimeMessage,
  MSG,
  type FillItemResponse,
  type PendingSaveResponse,
  type PageSuggestionsResponse,
  type SaveCheckResponse,
} from '../shared/messages.js';
import { toErrorCode } from '../shared/errors.js';
import { logWarn } from '../shared/logger.js';
import {
  collectCredentialInputs,
  isFieldRelevantMutation,
  isFieldVisible,
  observeFields,
} from './detector.js';
import type { DetectedField } from './detector.js';
import { fillFields } from './filler.js';
import { mountOverlay, type ItemRef, type OverlayController } from './overlay.js';
import { startSaveWatcher, type SaveWatcher } from './save-watcher.js';
import { startPasskeysRelay } from './passkeys-relay.js';

/**
 * 防止同一条内容脚本被注入两次（activeTab 注入与按站点注册的内容脚本可能叠加）。
 * 这是隔离世界里的一个布尔标记：页面脚本读不到，也不含任何凭证（S-4 针对的是凭证载体）。
 */
const BOOT_FLAG = '__vaultixContentLoaded';
const RESCAN_DEBOUNCE_MS = 150;

async function send<T>(message: Record<string, unknown>): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(message)) as T | null;
  } catch {
    // 扩展上下文已失效（例如刚被重新加载）：静默，不打扰页面
    return null;
  }
}

function pageUrl(): string {
  return location.href;
}

/** 只认可见字段：隐藏的诱饵输入框、确认密码框都不填 */
function visibleFields(): readonly DetectedField[] {
  const seen = new Set<string>();
  return collectCredentialInputs(document).filter((field) => {
    if (!isFieldVisible(field.element)) return false;
    if (seen.has(field.kind)) return false;
    seen.add(field.kind);
    return true;
  });
}

function applyPlan(plan: FillPlan, watcher: SaveWatcher | null): number {
  const fields = visibleFields();
  for (const field of fields) {
    const value = plan[field.kind];
    if (watcher !== null && value !== undefined && value.length > 0) {
      watcher.noteProgrammaticFill(field.element, value);
    }
  }
  return fillFields(fields, plan);
}

function sanitizePlan(value: unknown): FillPlan {
  const plan: { username?: string; password?: string; totp?: string } = {};
  if (typeof value !== 'object' || value === null) return plan;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.username === 'string') plan.username = candidate.username;
  if (typeof candidate.password === 'string') plan.password = candidate.password;
  if (typeof candidate.totp === 'string') plan.totp = candidate.totp;
  return plan;
}

function boot(): void {
  let overlay: OverlayController | null = null;
  // 通行密钥：主世界提供方 <-> 后台的中继（每个 frame 一次）
  startPasskeysRelay(document);

  const watcher = startSaveWatcher(document, {
    stage: (draft) => send<SaveCheckResponse>({ type: MSG.SAVE_CANDIDATE, draft }),
    offer: (draft, decision) => {
      if (overlay === null) return;
      if (decision === null) overlay.offerSave(draft);
      else overlay.restoreSave({ username: draft.username, decision });
    },
    pageUrl,
  });

  overlay = mountOverlay(document, {
    search: (url) => send<PageSuggestionsResponse>({ type: MSG.PAGE_SUGGESTIONS, url }),
    fill: (item: ItemRef, fields, copyTotp) =>
      send<FillItemResponse>({ type: MSG.FILL_ITEM, ...item, fields, url: pageUrl(), copyTotp }),
    copy: async (item: ItemRef, kind) => {
      const response = await send<{ ok: boolean }>({
        type: MSG.COPY_ITEM,
        ...item,
        kind,
        url: pageUrl(),
      });
      return response?.ok === true;
    },
    applyPlan: (plan) => applyPlan(plan, watcher),
    saveCheck: (draft) => send<SaveCheckResponse>({ type: MSG.SAVE_CANDIDATE, draft }),
    saveConfirm: (source: BackendSource) => send<SaveResult>({ type: MSG.SAVE_DECISION, source }),
    saveDismiss: async () => {
      await send({ type: MSG.SAVE_DECISION, source: null });
    },
    openPopup: async () => {
      try {
        await chrome.action.openPopup();
      } catch {
        // 浏览器不支持或缺少用户手势：静默
      }
    },
    pageUrl,
  });

  // 动态表单 / 单页应用：字段集合变化后重新定位浮层。
  // 只对与输入框有关的变动做出反应，避免频繁重渲染的页面触发全文档扫描。
  let rescanTimer: ReturnType<typeof setTimeout> | null = null;
  observeFields(document, (records) => {
    if (!records.some(isFieldRelevantMutation)) return;
    if (rescanTimer !== null) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      overlay?.rescan();
    }, RESCAN_DEBOUNCE_MS);
  });

  // 整页跳转后带过来的保存草稿：后台暂存着，这一页接着问
  void send<PendingSaveResponse>({ type: MSG.PENDING_SAVE }).then((pending) => {
    if (overlay !== null && pending !== null) overlay.restoreSave(pending);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isRuntimeMessage(message) || message.type !== MSG.FILL) return;
    // 消息来自扩展自身（隔离世界），凭证只写入 input.value，不污染页面上下文
    sendResponse({ filled: applyPlan(sanitizePlan(message.plan), watcher) });
  });
}

const scope = globalThis as unknown as Record<string, unknown>;
if (scope[BOOT_FLAG] !== true) {
  scope[BOOT_FLAG] = true;
  try {
    boot();
  } catch (error) {
    logWarn('content.boot.failed', { code: toErrorCode(error) });
  }
}
