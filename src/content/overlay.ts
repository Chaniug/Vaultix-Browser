/**
 * 页面内填充浮层：输入框内图标、候选列表、验证码图标、保存提示条。
 *
 * 设计要点
 *  - 挂在封闭 Shadow DOM：页面脚本读不到候选里的账号名（S-4）。
 *  - 浮层自己不持有密码：只发出「来源 + 条目 + 字段」，真实值由统一填充服务在用户
 *    点下去的那一刻取出，写入 input.value 之后即丢弃。
 *  - 只做显示与事件转发；过滤 / 键盘 / 定位 / 自动填充判定都在 overlay-model.ts。
 */
import type { FillField, FillPlan } from '../core/fill.js';
import type { Suggestion } from '../core/suggest.js';
import type { BackendSource, CredentialDraft, SaveResult } from '../core/types.js';
import type {
  FillItemResponse,
  PageSuggestionsResponse,
  SaveCheckResponse,
} from '../shared/messages.js';
import { collectCredentialInputs, isFieldVisible } from './detector.js';
import { OVERLAY_CSS } from './overlay-css.js';
import {
  filterSuggestions,
  PANEL_LIMITS,
  placeBar,
  placeIcon,
  placePanel,
  pickTotpSource,
  shouldAutoFill,
  stepSelection,
} from './overlay-model.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_LOCK = ['M7 11V7a5 5 0 0 1 10 0v4', 'M5 11h14v10H5z'];
const SUGGESTIONS_STALE_MS = 15_000;
const TOAST_MS = 1800;
/** 面板打开期间轻量轮询位置：页面动画 / 折叠展开不会触发 scroll 或 resize */
const OPEN_TICK_MS = 250;

export type ItemRef = Pick<Suggestion, 'source' | 'id'>;

export interface OverlayDeps {
  /** 取当前站点候选（不含密码） */
  readonly search: (url: string) => Promise<PageSuggestionsResponse | null>;
  /** 请求填充；返回要写入本 frame 的填充计划 */
  readonly fill: (
    item: ItemRef,
    fields: readonly FillField[],
    copyTotp: boolean,
  ) => Promise<FillItemResponse | null>;
  /** 复制某条目的密码或验证码 */
  readonly copy: (item: ItemRef, kind: 'password' | 'totp') => Promise<boolean>;
  /** 把填充计划写入本页面的输入框 */
  readonly applyPlan: (plan: FillPlan) => number;
  readonly saveCheck: (draft: CredentialDraft) => Promise<SaveCheckResponse | null>;
  /** 确认写入；草稿留在后台，这里只报来源 */
  readonly saveConfirm: (source: BackendSource) => Promise<SaveResult | null>;
  readonly saveDismiss: () => Promise<void>;
  /** 打开工具栏面板；浏览器不支持时静默失败 */
  readonly openPopup: () => Promise<void>;
  readonly pageUrl: () => string;
}

/** 保存提示所需的信息：判定结果 + 显示用的用户名（密码始终留在后台） */
export interface SavePromptData {
  readonly username: string;
  readonly decision: SaveCheckResponse;
}

export interface OverlayController {
  /** 字段集合可能变了（动态表单、页面跳转） */
  rescan(): void;
  /** 提交成功，询问是否保存（现场向后台判定） */
  offerSave(draft: CredentialDraft): void;
  /** 后台已有判定结果（整页跳转后带过来的暂存草稿），直接显示 */
  restoreSave(data: SavePromptData): void;
  destroy(): void;
}

interface State {
  username: HTMLInputElement | null;
  password: HTMLInputElement | null;
  totp: HTMLInputElement | null;
  /** 图标与候选面板锚定的输入框：有账号框用账号框，否则用密码框 */
  focusField: HTMLInputElement | null;
  items: readonly Suggestion[];
  visible: readonly Suggestion[];
  loaded: boolean;
  loadedAt: number;
  anyReady: boolean;
  autoFillOnLoad: boolean;
  open: boolean;
  activeIndex: number;
  mode: 'fill' | 'totp';
  autoFillDone: boolean;
  lastFilled: ItemRef | null;
  /** 用户主动关掉面板后，同一个输入框失焦前不再自动弹出 */
  dismissed: Set<HTMLInputElement>;
}

interface SavePrompt {
  readonly data: SavePromptData;
  readonly dismissKey: string;
  chosen: BackendSource;
}

type Box = {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
};

function el(doc: Document, tag: string, className: string, text?: string): HTMLElement {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(doc: Document, className: string, label: string): HTMLButtonElement {
  const node = doc.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  return node;
}

function svgIcon(doc: Document, paths: readonly string[]): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function sourceLabel(source: BackendSource): string {
  return source === 'keepassxc' ? 'KeePassXC' : 'Bitwarden';
}

function saveKey(draft: CredentialDraft): string {
  return `${draft.username}\n${draft.password}`;
}

export function mountOverlay(
  doc: Document,
  deps: OverlayDeps,
  options: { readonly shadowMode?: 'open' | 'closed' } = {},
): OverlayController | null {
  const maybeView = doc.defaultView;
  // 显式标注为非空：被提升的内部函数无法沿用上面的空值收窄
  if (maybeView === null) return null;
  const view: Window = maybeView;

  const state: State = {
    username: null,
    password: null,
    totp: null,
    focusField: null,
    items: [],
    visible: [],
    loaded: false,
    loadedAt: 0,
    anyReady: false,
    autoFillOnLoad: false,
    open: false,
    activeIndex: -1,
    mode: 'fill',
    autoFillDone: false,
    lastFilled: null,
    dismissed: new Set<HTMLInputElement>(),
  };
  let rowElements: HTMLElement[] = [];
  let savePrompt: SavePrompt | null = null;
  let toastTimer: number | null = null;
  let layoutFrame: number | null = null;
  let openTicker: number | null = null;
  let lastUrl = deps.pageUrl();
  const dismissedSaves = new Set<string>();

  // 封闭 Shadow DOM：页面脚本拿不到 shadowRoot，候选里的账号名不会泄露给页面
  const host = doc.createElement('div');
  const shadow = host.attachShadow({ mode: options.shadowMode ?? 'closed' });
  const style = el(doc, 'style', '');
  style.textContent = OVERLAY_CSS;
  const shell = el(doc, 'div', 'vx-root');

  const iconButton = button(doc, 'vx-icon vx-hidden', '');
  iconButton.setAttribute('aria-label', 'Vaultix：查看匹配的凭证');
  iconButton.append(svgIcon(doc, ICON_LOCK));

  const totpButton = button(doc, 'vx-icon totp vx-hidden', '');
  totpButton.setAttribute('aria-label', 'Vaultix：填入验证码');
  const totpGlyph = doc.createElementNS(SVG_NS, 'svg');
  totpGlyph.setAttribute('viewBox', '0 0 24 24');
  totpGlyph.setAttribute('aria-hidden', 'true');
  const totpText = doc.createElementNS(SVG_NS, 'text');
  totpText.setAttribute('x', '12');
  totpText.setAttribute('y', '16.5');
  totpText.setAttribute('text-anchor', 'middle');
  totpText.setAttribute('font-size', '11');
  totpText.setAttribute('font-weight', '700');
  totpText.setAttribute('fill', 'currentColor');
  totpText.setAttribute('stroke', 'none');
  totpText.textContent = 'OTP';
  totpGlyph.append(totpText);
  totpButton.append(totpGlyph);

  const panel = el(doc, 'div', 'vx-panel vx-hidden');
  panel.setAttribute('role', 'listbox');
  const bar = el(doc, 'div', 'vx-bar vx-hidden');
  const toast = el(doc, 'div', 'vx-bar vx-toast vx-hidden');
  toast.setAttribute('role', 'status');
  shell.append(iconButton, totpButton, panel, bar, toast);
  shadow.append(style, shell);

  // 浮层内的事件不冒泡到页面：页面脚本看不到用户在浮层里的操作
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup']) {
    shell.addEventListener(type, (event) => {
      event.stopPropagation();
    });
  }
  // 点浮层里的按钮不让输入框失焦：很多站点一失焦就重渲染表单
  shell.addEventListener('mousedown', (event) => {
    if (event.target instanceof HTMLElement && event.target.closest('button') !== null) {
      event.preventDefault();
    }
  });

  function rectOf(input: HTMLInputElement): Box {
    const rect = input.getBoundingClientRect();
    return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
  }

  function inViewport(input: HTMLInputElement): boolean {
    const rect = input.getBoundingClientRect();
    return (
      rect.top < view.innerHeight &&
      rect.bottom > 0 &&
      rect.left < view.innerWidth &&
      rect.right > 0
    );
  }

  function currentQuery(): string {
    return state.focusField !== null && state.focusField === state.username
      ? state.focusField.value
      : '';
  }

  function initialActive(): number {
    return currentQuery().trim().length > 0 && state.visible.length > 0 ? 0 : -1;
  }

  function scanFields(): void {
    const visible = collectCredentialInputs(doc).filter((field) => isFieldVisible(field.element));
    state.username = visible.find((field) => field.kind === 'username')?.element ?? null;
    state.password = visible.find((field) => field.kind === 'password')?.element ?? null;
    state.totp = visible.find((field) => field.kind === 'totp')?.element ?? null;
    const next = state.username ?? state.password;
    if (next !== state.focusField) {
      state.focusField = next;
      closePanel(false);
    }
  }

  function layout(): void {
    layoutFrame = null;
    const viewport = { width: view.innerWidth, height: view.innerHeight };
    const field = state.focusField;

    // 没有任何可用凭证库时显示灰色图标作为引导；
    // 凭证库可用但本站没有匹配时不打扰（多半是注册页之类）
    const showIcon =
      state.loaded &&
      field !== null &&
      inViewport(field) &&
      (!state.anyReady || state.items.length > 0);
    iconButton.classList.toggle('vx-hidden', !showIcon);
    iconButton.classList.toggle('muted', !state.anyReady);
    if (showIcon) {
      const position = placeIcon(rectOf(field));
      iconButton.style.left = `${Math.round(position.left).toString()}px`;
      iconButton.style.top = `${Math.round(position.top).toString()}px`;
    }

    const showTotp =
      state.totp !== null && inViewport(state.totp) && state.items.some((item) => item.hasTotp);
    totpButton.classList.toggle('vx-hidden', !showTotp);
    if (showTotp && state.totp !== null) {
      const position = placeIcon(rectOf(state.totp));
      totpButton.style.left = `${Math.round(position.left).toString()}px`;
      totpButton.style.top = `${Math.round(position.top).toString()}px`;
    }

    if (state.open && field !== null) {
      const anchor = rectOf(field);
      const position = placePanel(anchor, viewport);
      panel.style.left = `${Math.round(position.left).toString()}px`;
      panel.style.width = `${Math.round(position.width).toString()}px`;
      panel.style.maxHeight = `${Math.round(position.maxHeight).toString()}px`;
      panel.style.top =
        position.placement === 'above'
          ? `${Math.round(anchor.top - PANEL_LIMITS.gap - panel.offsetHeight).toString()}px`
          : `${Math.round(position.top).toString()}px`;
    }

    if (savePrompt !== null) {
      const position = placeBar(viewport);
      bar.style.left = `${Math.round(position.left).toString()}px`;
      bar.style.top = `${Math.round(position.top).toString()}px`;
      bar.style.width = `${Math.round(position.width).toString()}px`;
    }
    if (toastTimer !== null) {
      const position = placeBar(viewport, 320);
      toast.style.left = `${Math.round(position.left).toString()}px`;
      toast.style.top = `${Math.round(position.top).toString()}px`;
      toast.style.width = `${Math.round(position.width).toString()}px`;
    }
  }

  function scheduleLayout(): void {
    if (layoutFrame !== null) return;
    layoutFrame = view.requestAnimationFrame(layout);
  }

  function footButton(): HTMLElement {
    const foot = el(doc, 'div', 'vx-foot');
    const open = button(doc, 'vx-foot-btn', '打开完整面板');
    open.addEventListener('click', () => {
      closePanel(false);
      void deps.openPopup();
    });
    foot.append(open);
    return foot;
  }

  function showEmptyPanel(message: string, withFoot: boolean): void {
    panel.replaceChildren(
      el(doc, 'div', 'vx-panel-head', 'Vaultix'),
      el(doc, 'div', 'vx-empty', message),
      ...(withFoot ? [footButton()] : []),
    );
    state.visible = [];
    rowElements = [];
    state.activeIndex = -1;
  }

  function closePanel(dismiss: boolean): void {
    state.open = false;
    panel.classList.add('vx-hidden');
    if (openTicker !== null) {
      view.clearInterval(openTicker);
      openTicker = null;
    }
    if (dismiss) {
      for (const field of [state.username, state.password, state.totp]) {
        if (field !== null) state.dismissed.add(field);
      }
    }
  }

  function flash(text: string): void {
    if (toastTimer !== null) view.clearTimeout(toastTimer);
    toast.textContent = text;
    toast.classList.remove('vx-hidden');
    layout();
    toastTimer = view.setTimeout(() => {
      toast.classList.add('vx-hidden');
      toastTimer = null;
    }, TOAST_MS);
  }

  function paintActive(): void {
    rowElements.forEach((row, index) => {
      row.classList.toggle('active', index === state.activeIndex);
    });
    const current = rowElements[state.activeIndex];
    if (current === undefined) return;
    const bottom = current.offsetTop + current.offsetHeight;
    if (bottom > panel.scrollTop + panel.clientHeight) {
      panel.scrollTop = bottom - panel.clientHeight;
    }
  }

  function setActive(index: number): void {
    if (index === state.activeIndex) return;
    state.activeIndex = index;
    paintActive();
  }

  async function fill(
    item: ItemRef,
    fields: readonly FillField[],
    copyTotp: boolean,
  ): Promise<void> {
    const response = await deps.fill(item, fields, copyTotp);
    if (response === null || !response.ok || response.plan === undefined) return;
    deps.applyPlan(response.plan);
    state.lastFilled = { source: item.source, id: item.id };
    closePanel(true);
    if (fields.includes('totp')) flash('验证码已更新');
  }

  async function useTotp(item: Suggestion): Promise<void> {
    if (state.totp === null) {
      const ok = await deps.copy(item, 'totp');
      if (ok) {
        closePanel(false);
        flash('验证码已复制，30 秒后自动清空');
      }
      return;
    }
    await fill(item, ['totp'], true);
  }

  function primaryAction(item: Suggestion): void {
    if (state.mode === 'totp') {
      void useTotp(item);
      return;
    }
    const fields: FillField[] = ['username', 'password'];
    if (state.totp !== null) fields.push('totp');
    void fill(item, fields, item.hasTotp);
  }

  function renderRow(item: Suggestion, index: number): HTMLElement {
    const row = el(doc, 'div', 'vx-row');
    row.setAttribute('role', 'option');
    if (index === state.activeIndex) row.classList.add('active');

    const main = el(doc, 'div', 'vx-row-main');
    main.append(
      el(
        doc,
        'span',
        `vx-badge ${item.source === 'keepassxc' ? 'kp' : 'bw'}`,
        item.source === 'keepassxc' ? 'KP' : 'BW',
      ),
    );
    main.append(el(doc, 'span', 'vx-row-name', item.name));

    const actions = el(doc, 'div', 'vx-row-actions');
    const mainButton = button(doc, 'vx-btn primary', state.mode === 'totp' ? '验证码' : '填充');
    mainButton.addEventListener('click', (event) => {
      event.stopPropagation();
      primaryAction(item);
    });
    actions.append(mainButton);
    if (item.hasTotp && state.mode !== 'totp') {
      const totpAction = button(doc, 'vx-btn compact', '验证码');
      totpAction.addEventListener('click', (event) => {
        event.stopPropagation();
        void useTotp(item);
      });
      actions.append(totpAction);
    }
    const copyAction = button(doc, 'vx-btn compact', '复制密码');
    copyAction.addEventListener('click', (event) => {
      event.stopPropagation();
      void deps.copy(item, 'password').then((ok) => {
        if (ok) flash('密码已复制，30 秒后自动清空');
      });
    });
    actions.append(copyAction);
    main.append(actions);

    row.append(
      main,
      el(doc, 'div', 'vx-row-user', item.username.length > 0 ? item.username : '（无用户名）'),
    );
    row.addEventListener('click', () => {
      primaryAction(item);
    });
    row.addEventListener('mouseenter', () => {
      setActive(index);
    });
    return row;
  }

  function renderList(): void {
    panel.replaceChildren();
    if (!state.loaded) {
      showEmptyPanel('正在取用凭证…', false);
      return;
    }
    if (!state.anyReady) {
      showEmptyPanel('凭证库尚未连接：请点击工具栏图标完成配对或登录', true);
      return;
    }
    if (state.items.length === 0) {
      showEmptyPanel('当前站点没有匹配的凭证', true);
      return;
    }
    const ambiguous = new Set(state.items.map((item) => item.source)).size > 1;
    state.visible = filterSuggestions(state.items, currentQuery());
    rowElements = state.visible.map((item, index) => renderRow(item, index));
    const head = el(
      doc,
      'div',
      'vx-panel-head',
      `${state.visible.length.toString()} 条匹配凭证${ambiguous ? ' · 默认库优先' : ''}`,
    );
    panel.append(head, ...rowElements, footButton());
  }

  function openPanel(mode: 'fill' | 'totp'): void {
    if (state.focusField === null) return;
    const changed = !state.open || state.mode !== mode;
    state.open = true;
    state.mode = mode;
    panel.classList.remove('vx-hidden');
    if (changed) {
      renderList();
      state.activeIndex = initialActive();
      paintActive();
    }
    layout();
    if (openTicker === null) openTicker = view.setInterval(layout, OPEN_TICK_MS);
    if (!state.loaded || Date.now() - state.loadedAt > SUGGESTIONS_STALE_MS) {
      void loadSuggestions();
    }
  }

  async function loadSuggestions(): Promise<void> {
    try {
      const response = await deps.search(deps.pageUrl());
      if (response === null) return;
      state.items = response.items;
      state.anyReady = response.anyReady;
      state.autoFillOnLoad = response.autoFillOnLoad;
      state.loaded = true;
      state.loadedAt = Date.now();
      if (state.open) {
        renderList();
        state.activeIndex = Math.min(state.activeIndex, state.visible.length - 1);
        paintActive();
      }
      layout();
      maybeAutoFill();
    } catch {
      // 后台暂不可用（例如扩展刚被重新加载）：保持现状，下次聚焦会重试
    }
  }

  function maybeAutoFill(): void {
    if (state.autoFillDone) return;
    // 一次页面生命周期内只尝试一次：字段变化时不反复覆盖用户正在输入的内容
    state.autoFillDone = true;
    const username = state.username;
    const password = state.password;
    if (username === null || password === null) return;
    let secureContext = false;
    try {
      secureContext = new URL(deps.pageUrl()).protocol === 'https:';
    } catch {
      secureContext = false;
    }
    const allowed = shouldAutoFill({
      enabled: state.autoFillOnLoad,
      matchCount: state.items.length,
      usernameEmpty: username.value.length === 0,
      passwordEmpty: password.value.length === 0,
      secureContext,
      topFrame: view === view.top,
    });
    const only = state.items.length === 1 ? state.items[0] : undefined;
    if (!allowed || only === undefined) return;
    void fill(only, ['username', 'password'], false);
  }

  function credentialField(target: EventTarget | null): HTMLInputElement | null {
    if (!(target instanceof HTMLInputElement)) return null;
    return target === state.username || target === state.password || target === state.totp
      ? target
      : null;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!state.open) return;
    const field = credentialField(event.target);
    if (field === null || field === state.totp) return;
    if (event.key === 'Escape') {
      closePanel(true);
      return;
    }
    if (state.visible.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(
        stepSelection(state.activeIndex, event.key === 'ArrowDown' ? 1 : -1, state.visible.length),
      );
      return;
    }
    if (event.key === 'Enter' && state.activeIndex >= 0 && !event.isComposing) {
      const item = state.visible[state.activeIndex];
      if (item === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      primaryAction(item);
    }
  }

  function onFocusIn(event: FocusEvent): void {
    const target = credentialField(event.target);
    if (target === null) {
      // 焦点离开了凭证输入框，也不在浮层里 → 收起
      if (state.open && event.target instanceof Node && !host.contains(event.target)) {
        closePanel(false);
      }
      return;
    }
    // 验证码框聚焦不弹候选：验证码用输入框内的验证码图标，避免打扰
    if (target === state.totp || state.dismissed.has(target)) return;
    openPanel('fill');
  }

  function onFocusOut(event: FocusEvent): void {
    const target = credentialField(event.target);
    if (target === null) return;
    // 离开这个输入框后，"用户主动关闭"的记忆作废，下次再聚焦还会弹
    state.dismissed.delete(target);
    if (state.open && credentialField(event.relatedTarget) === null) closePanel(false);
  }

  function onInput(event: Event): void {
    const target = credentialField(event.target);
    if (target === null || target !== state.username || !state.open || state.mode !== 'fill')
      return;
    renderList();
    state.activeIndex = initialActive();
    paintActive();
    layout();
  }

  function onPointerDown(event: Event): void {
    if (event.target instanceof Node && host.contains(event.target)) return;
    if (state.open) closePanel(true);
  }

  // ---------- 保存提示条 ----------

  function renderBar(): void {
    bar.replaceChildren();
    const prompt = savePrompt;
    if (prompt === null) {
      bar.classList.add('vx-hidden');
      return;
    }
    const decision = prompt.data.decision;
    const target = decision.target;
    const update = decision.action === 'update' && target !== undefined;
    const text = el(
      doc,
      'div',
      'vx-bar-text',
      update
        ? `密码已更改，更新「${target.name}」？`
        : `保存到 ${sourceLabel(prompt.chosen)}？${prompt.data.username}`,
    );
    const actions = el(doc, 'div', 'vx-bar-actions');
    const confirm = button(doc, 'vx-btn primary', update ? '更新' : '保存');
    confirm.addEventListener('click', () => {
      void confirmSave();
    });
    actions.append(confirm);
    const dismiss = button(doc, 'vx-btn', '忽略');
    dismiss.addEventListener('click', () => {
      const current = savePrompt;
      savePrompt = null;
      if (current !== null) dismissedSaves.add(current.dismissKey);
      void deps.saveDismiss();
      renderBar();
    });
    actions.append(dismiss);

    if (!update && decision.sources.length > 1) {
      const switcher = el(doc, 'div', 'vx-src');
      for (const source of decision.sources) {
        const option = button(doc, source === prompt.chosen ? 'active' : '', sourceLabel(source));
        option.addEventListener('click', () => {
          if (savePrompt === null) return;
          savePrompt = { ...savePrompt, chosen: source };
          renderBar();
        });
        switcher.append(option);
      }
      bar.append(switcher);
    }
    bar.append(text, actions);
    bar.classList.remove('vx-hidden');
    layout();
  }

  async function confirmSave(): Promise<void> {
    const prompt = savePrompt;
    if (prompt === null) return;
    const target = prompt.data.decision.target;
    savePrompt = null;
    renderBar();
    const result = await deps.saveConfirm(prompt.chosen);
    if (result !== null && result.ok) {
      flash(
        target !== undefined
          ? `已更新「${target.name}」`
          : `已保存到 ${sourceLabel(prompt.chosen)}`,
      );
      void loadSuggestions();
    } else {
      flash('保存失败，请打开面板重试');
    }
  }

  async function offerSaveInternal(draft: CredentialDraft): Promise<void> {
    const dismissKey = saveKey(draft);
    if (dismissedSaves.has(dismissKey)) return;
    const decision = await deps.saveCheck(draft);
    if (decision === null || decision.action === 'none') return;
    showSavePrompt({ username: draft.username, decision }, dismissKey);
  }

  function showSavePrompt(data: SavePromptData, dismissKey: string): void {
    if (data.decision.action === 'none' || dismissedSaves.has(dismissKey)) return;
    const chosen = data.decision.sources[0];
    if (chosen === undefined) return;
    savePrompt = { data, dismissKey, chosen };
    renderBar();
  }

  function onVisibilityChange(): void {
    if (doc.visibilityState === 'hidden') closePanel(false);
  }

  // ---------- 事件接线 ----------

  iconButton.addEventListener('click', () => {
    if (state.open) {
      closePanel(true);
      return;
    }
    openPanel('fill');
  });
  totpButton.addEventListener('click', () => {
    const target = pickTotpSource(state.items, state.lastFilled);
    if (target === undefined) {
      openPanel(state.items.length === 0 ? 'fill' : 'totp');
      return;
    }
    void fill(target, ['totp'], true);
  });

  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('focusout', onFocusOut, true);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('input', onInput, true);
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('visibilitychange', onVisibilityChange);
  view.addEventListener('scroll', scheduleLayout, { capture: true, passive: true });
  view.addEventListener('resize', scheduleLayout, { passive: true });

  function rescan(): void {
    // 页面可能把宿主节点删掉：接回去即可（内容在 Shadow DOM 里不受影响）
    if (!host.isConnected) doc.documentElement.append(host);
    const url = deps.pageUrl();
    if (url !== lastUrl) {
      // 单页应用跳转：提示条作废，自动填充机会恢复
      lastUrl = url;
      savePrompt = null;
      dismissedSaves.clear();
      state.autoFillDone = false;
      state.loaded = false;
      renderBar();
    }
    scanFields();
    if (state.focusField !== null && !state.loaded) void loadSuggestions();
    layout();
  }

  function destroy(): void {
    doc.removeEventListener('focusin', onFocusIn, true);
    doc.removeEventListener('focusout', onFocusOut, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener('input', onInput, true);
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('visibilitychange', onVisibilityChange);
    view.removeEventListener('scroll', scheduleLayout, true);
    view.removeEventListener('resize', scheduleLayout);
    if (openTicker !== null) view.clearInterval(openTicker);
    if (toastTimer !== null) view.clearTimeout(toastTimer);
    if (layoutFrame !== null) view.cancelAnimationFrame(layoutFrame);
    host.remove();
  }

  rescan();
  return {
    rescan,
    offerSave: (draft) => {
      void offerSaveInternal(draft);
    },
    restoreSave: (data) => {
      showSavePrompt(data, `restored:${data.username}`);
    },
    destroy,
  };
}
