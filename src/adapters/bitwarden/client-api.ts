/**
 * Bitwarden Client API 薄客户端：官方云与 Vaultwarden 共用同一套代码，仅 endpoints 不同（DEC-002）。
 * S-3：地址集中在此模块构造并强制 HTTPS；S-2：错误只映射为稳定码，不回显响应体。
 */
import { ERROR_CODES, VaultixError } from '../../shared/errors.js';
import { assertHttpsOrLoopback } from '../../shared/url.js';
import type {
  BitwardenEndpoints,
  BitwardenMode,
  PreloginResponse,
  SyncResponse,
  TokenResponse,
} from './types.js';

export const CLOUD_ENDPOINTS: Omit<BitwardenEndpoints, 'origin'> = {
  apiBase: 'https://api.bitwarden.com',
  identityBase: 'https://identity.bitwarden.com',
};

export function resolveEndpoints(serverUrl: string, mode: BitwardenMode): BitwardenEndpoints {
  const origin = assertHttpsOrLoopback(serverUrl);
  if (mode === 'bitwarden.cloud') {
    return { ...CLOUD_ENDPOINTS, origin };
  }
  return {
    origin,
    // 路径统一由调用方拼 /api/...，因此 apiBase 只到 origin（官方云则是 api 子域）
    apiBase: origin,
    identityBase: `${origin}/identity`,
  };
}

export interface ClientApiOptions {
  readonly timeoutMs?: number;
  /** 运行时 host 权限申请；测试可注入 */
  readonly requestPermission?: (origin: string) => Promise<boolean>;
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly token?: string;
  readonly form?: Record<string, string>;
}

export class BitwardenClient {
  readonly endpoints: BitwardenEndpoints;

  constructor(
    serverUrl: string,
    mode: BitwardenMode,
    private readonly options: ClientApiOptions = {},
  ) {
    this.endpoints = resolveEndpoints(serverUrl, mode);
  }

  async prelogin(email: string): Promise<PreloginResponse> {
    const url = `${this.endpoints.apiBase}/api/accounts/prelogin?email=${encodeURIComponent(email)}`;
    const data = await this.requestJson<Record<string, unknown>>(url);
    const kdf = typeof data.kdf === 'number' ? data.kdf : 0;
    const iterations = data.kdfIterations;
    if (kdf !== 0 || typeof iterations !== 'number') {
      throw new VaultixError(ERROR_CODES.PROTOCOL_MISMATCH);
    }
    return { kdf, kdfIterations: iterations };
  }

  async loginWithApiKey(clientId: string, clientSecret: string): Promise<TokenResponse> {
    return this.tokenRequest({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'api',
      ...this.deviceFields(),
    });
  }

  async loginWithPassword(
    email: string,
    stretchedKeyBase64: string,
    twoFactorCode?: string,
  ): Promise<TokenResponse> {
    const form: Record<string, string> = {
      grant_type: 'password',
      scope: 'api offline_access',
      client_id: 'browser',
      ...this.deviceFields(),
      username: email,
      password: stretchedKeyBase64,
    };
    if (twoFactorCode !== undefined) {
      form.twoFactorCode = twoFactorCode;
      form.twoFactorMethod = '0';
    }
    return this.tokenRequest(form);
  }

  async refreshToken(refreshToken: string): Promise<TokenResponse> {
    return this.tokenRequest({
      grant_type: 'refresh_token',
      client_id: 'browser',
      refresh_token: refreshToken,
      ...this.deviceFields(),
    });
  }

  async sync(token: string): Promise<SyncResponse> {
    const url = `${this.endpoints.apiBase}/api/sync?excludeDomains=true`;
    const data = await this.requestJson<Record<string, unknown>>(url, {
      token,
    });
    const profile = data.profile;
    const protectedKey =
      typeof profile === 'object' && profile !== null
        ? (profile as Record<string, unknown>).key
        : undefined;
    return {
      ciphers: Array.isArray(data.ciphers) ? data.ciphers : [],
      profile:
        typeof protectedKey === 'string' && protectedKey.length > 0 ? { key: protectedKey } : null,
    };
  }

  private deviceFields(): Record<string, string> {
    return {
      deviceType: '8',
      deviceName: 'Vaultix Browser',
      deviceIdentifier:
        typeof globalThis.crypto.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : '00000000-0000-0000-0000-000000000000',
    };
  }

  private async tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
    const url = `${this.endpoints.identityBase}/connect/token`;
    const data = await this.requestJson<Record<string, unknown>>(url, {
      method: 'POST',
      form,
    });
    const token = data.access_token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new VaultixError(ERROR_CODES.INVALID_CREDENTIALS);
    }
    const refresh = data.refresh_token;
    return {
      access_token: token,
      expires_in: typeof data.expires_in === 'number' ? data.expires_in : 3600,
      token_type: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
      ...(typeof refresh === 'string' ? { refresh_token: refresh } : {}),
    };
  }

  private async requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
    await this.ensurePermission(new URL(url).origin);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.options.timeoutMs ?? 15_000);
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (options.token !== undefined) {
        headers.Authorization = `Bearer ${options.token}`;
      }
      let body: string | null = null;
      if (options.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(options.form).toString();
      }
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw this.mapHttpError(response.status, options.method);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof VaultixError) throw error;
      throw new VaultixError(ERROR_CODES.NETWORK_ERROR);
    } finally {
      clearTimeout(timer);
    }
  }

  private mapHttpError(status: number, method?: string): VaultixError {
    if (status === 401) {
      return new VaultixError(
        method === 'POST' ? ERROR_CODES.INVALID_CREDENTIALS : ERROR_CODES.PERMISSION_DENIED,
      );
    }
    if (status === 400 && method === 'POST') {
      return new VaultixError(ERROR_CODES.TWO_FACTOR_REQUIRED);
    }
    return new VaultixError(ERROR_CODES.NETWORK_ERROR);
  }

  private async ensurePermission(origin: string): Promise<void> {
    const requested = this.options.requestPermission;
    if (!requested) return;
    const granted = await requested(origin);
    if (!granted) throw new VaultixError(ERROR_CODES.PERMISSION_DENIED);
  }
}

/** 默认权限申请：M-3 运行时 optional host permission，不写死域名 */
export async function requestHostPermission(origin: string): Promise<boolean> {
  const api = (globalThis as { chrome?: ChromeApi }).chrome;
  if (!api?.permissions) return true;
  const pattern = `${origin}/*`;
  try {
    if (await api.permissions.contains({ origins: [pattern] })) return true;
    return await api.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}
