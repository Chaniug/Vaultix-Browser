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
}

interface ChromeScripting {
  executeScript(injection: { target: { tabId: number }; files: string[] }): Promise<unknown[]>;
}

interface ChromeTabs {
  query(queryInfo: ChromeMessage): Promise<ChromeTab[]>;
  sendMessage(tabId: number, message: ChromeMessage): Promise<ChromeMessage>;
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

interface ChromeApi {
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
  readonly notifications: ChromeNotifications;
  readonly contextMenus: ChromeContextMenus;
}

declare const chrome: ChromeApi;
