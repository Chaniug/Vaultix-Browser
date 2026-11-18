import { ERROR_CODES, VaultixError } from '../../shared/errors.js';
import { NATIVE_APP_ID } from './types.js';
import type { KeePassWireResponse, NativeTransport } from './types.js';

interface Pending {
  readonly resolve: (value: KeePassWireResponse) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * 通过 keepassxc-proxy 的 Native Messaging 通道通信（M-1/M-2：不占 host 权限）。
 * 协议本身为请求-响应串行，因此这里限定单实例单在途请求。
 */
export class ChromeNativeTransport implements NativeTransport {
  private port: ChromePort | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs = 8000) {}

  get connected(): boolean {
    return this.port !== null;
  }

  connect(): Promise<void> {
    if (this.port) return Promise.resolve();
    try {
      const port = chrome.runtime.connectNative(NATIVE_APP_ID);
      port.onMessage.addListener((message) => {
        this.onMessage(message);
      });
      port.onDisconnect.addListener(() => {
        this.onDisconnect();
      });
      this.port = port;
      return Promise.resolve();
    } catch {
      return Promise.reject(new VaultixError(ERROR_CODES.NATIVE_PROXY_MISSING));
    }
  }

  send(message: Record<string, unknown>): Promise<KeePassWireResponse> {
    const port = this.port;
    if (!port) throw new VaultixError(ERROR_CODES.NATIVE_PROXY_MISSING);
    const key = typeof message.clientID === 'string' ? message.clientID : '';
    if (this.pending.size > 0) {
      return Promise.reject(new VaultixError(ERROR_CODES.PROTOCOL_MISMATCH));
    }
    return new Promise<KeePassWireResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new VaultixError(ERROR_CODES.NETWORK_ERROR));
      }, this.timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
      try {
        port.postMessage(message);
      } catch {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(new VaultixError(ERROR_CODES.NATIVE_PROXY_MISSING));
      }
    });
  }

  disconnect(): void {
    this.port?.disconnect();
    this.port = null;
    this.onDisconnect();
  }

  private onMessage(message: Record<string, unknown>): void {
    const key = typeof message.clientID === 'string' ? message.clientID : '';
    const entry = this.pending.get(key) ?? this.pending.values().next().value;
    if (!entry) return;
    clearTimeout(entry.timer);
    if (!this.pending.has(key)) {
      const found = [...this.pending.entries()].find(([, value]) => value === entry);
      if (found) this.pending.delete(found[0]);
    } else {
      this.pending.delete(key);
    }
    entry.resolve(message);
  }

  private onDisconnect(): void {
    this.port = null;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new VaultixError(ERROR_CODES.NATIVE_PROXY_MISSING));
    }
    this.pending.clear();
  }
}
