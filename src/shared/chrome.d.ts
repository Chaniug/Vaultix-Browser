/**
 * 最小 Chrome Extension API 类型声明。
 * 不引入 @types/chrome，避免为一个闭包 API 拉入庞大类型包（S-8 依赖锁定）。
 * 仅声明本项目实际使用的接口；缺失时在此按需扩充。
 */

type ChromeMessage = Record<string, unknown>;

interface ChromeStorageArea {
  get(keys?: string | string[] | null): Promise<ChromeMessage>;
  set(items: ChromeMessage): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface ChromeTab {
  readonly id?: number;
  readonly url?: string;
  readonly title?: string;
  readonly active?: boolean;
}

interface ChromePort {
  readonly name: string;
  onMessage: {
    addListener(cb: (message: ChromeMessage) => void): void;
  };
  onDisconnect: {
    addListener(cb: () => void): void;
  };
  postMessage(message: ChromeMessage): void;
  disconnect(): void;
}

interface ChromeRuntime {
  readonly id: string;
  readonly lastError?: { readonly message: string };
  connectNative(application: string): ChromePort;
  sendMessage(message: ChromeMessage): Promise<ChromeMessage>;
  openOptionsPage(): Promise<void>;
  onMessage: {
    addListener(
      cb: (
        message: ChromeMessage,
        sender: ChromeMessageSender,
        sendResponse: (response?: unknown) => void,
      ) => unknown,
    ): void;
  };
  onInstalled: {
    addListener(cb: (details: ChromeMessage) => void): void;
  };
}

interface ChromeMessageSender {
  readonly tab?: ChromeTab;
  readonly id?: string;
  readonly url?: string;
}

interface ChromePermissions {
  contains(permissions: ChromeMessage): Promise<boolean>;
  request(permissions: ChromeMessage): Promise<boolean>;
  remove(permissions: ChromeMessage): Promise<boolean>;
  /** 已授予的权限与 host 匹配串（含运行时按站点授予的 optional host） */
  getAll(): Promise<{
    readonly origins?: readonly string[];
    readonly permissions?: readonly string[];
  }>;
  onAdded: {
    addListener(cb: (permissions: ChromeMessage) => void): void;
  };
  onRemoved: {
    addListener(cb: (permissions: ChromeMessage) => void): void;
  };
}

interface RegisteredContentScript {
  readonly id: string;
}

interface ChromeScripting {
  /** world: 'MAIN' 用于注入页面主世界脚本（通行密钥需要） */
  executeScript(injection: {
    target: { tabId: number };
    files: string[];
    world?: 'ISOLATED' | 'MAIN';
  }): Promise<unknown[]>;
  getRegisteredContentScripts(): Promise<readonly RegisteredContentScript[]>;
  registerContentScripts(scripts: readonly ChromeMessage[]): Promise<void>;
  updateContentScripts(scripts: readonly ChromeMessage[]): Promise<void>;
  unregisterContentScripts(filter: { ids: readonly string[] }): Promise<void>;
}

interface ChromeTabs {
  query(queryInfo: ChromeMessage): Promise<ChromeTab[]>;
  sendMessage(tabId: number, message: ChromeMessage): Promise<ChromeMessage>;
}

/** 只需窗口焦点事件；不读取标签页内容，因此不需要额外权限 */
interface ChromeWindows {
  readonly WINDOW_ID_NONE: number;
  onFocusChanged: {
    addListener(cb: (windowId: number) => void): void;
  };
}

interface ChromeNotifications {
  create(options: ChromeMessage): Promise<string>;
}

interface ChromeContextMenus {
  create(options: ChromeMessage): void;
  onClicked: {
    addListener(cb: (info: ChromeMessage, tab?: ChromeTab) => void): void;
  };
}

interface ChromeOffscreen {
  createDocument(options: {
    readonly url: string;
    readonly reasons: readonly string[];
    readonly justification: string;
  }): Promise<void>;
  hasDocument(): Promise<boolean>;
}

interface ChromeAction {
  /** 需要用户手势；Chrome 127+ 对所有扩展开放，不支持时会 reject */
  openPopup(): Promise<void>;
}

interface ChromeApi {
  readonly action: ChromeAction;
  readonly offscreen: ChromeOffscreen;
  readonly runtime: ChromeRuntime;
  readonly storage: {
    readonly session: ChromeStorageArea;
    readonly local: ChromeStorageArea;
    readonly sync: ChromeStorageArea;
  };
  readonly permissions: ChromePermissions;
  readonly scripting: ChromeScripting;
  readonly tabs: ChromeTabs;
  readonly windows: ChromeWindows;
  readonly notifications: ChromeNotifications;
  readonly contextMenus: ChromeContextMenus;
}

declare const chrome: ChromeApi;
