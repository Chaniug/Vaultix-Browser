/** Bitwarden Client API 配置与数据模型（官方云 / Vaultwarden 共用，仅 endpoints 不同）。 */

export type BitwardenMode = 'bitwarden.cloud' | 'vaultwarden';

export interface BitwardenConfig {
  /** 用户填写的服务地址；官方云填 https://vault.bitwarden.com 亦可，由 mode 决定实际 endpoints */
  readonly serverUrl: string;
  readonly mode: BitwardenMode;
  /** API Key 登录（推荐） */
  readonly clientId?: string;
  readonly clientSecret?: string;
  /** 主密码登录（仅内存态，禁止持久化，S-1） */
  readonly email?: string;
  readonly masterPassword?: string;
  /** 已存在的会话 token（来自 chrome.storage.session） */
  readonly accessToken?: string;
  readonly refreshToken?: string;
  /** 已解密对称密钥的 Base64（仅会话态，禁止写入 storage.local，S-1） */
  readonly symmetricKey?: string;
  /** 覆盖 KDF 迭代次数（调试 / 兼容旧库） */
  readonly kdfIterations?: number;
  /** 一次性验证码（2FA） */
  readonly twoFactorCode?: string;
  /** 请求超时，默认 15000ms */
  readonly timeoutMs?: number;
}

export interface BitwardenEndpoints {
  readonly apiBase: string;
  readonly identityBase: string;
  readonly origin: string;
}

export interface TokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly token_type: string;
}

export interface CipherLogin {
  readonly username?: string | null;
  readonly password?: string | null;
  readonly totp?: string | null;
  readonly uris?: readonly { readonly uri?: string | null; readonly match?: number | null }[];
}

export interface Cipher {
  readonly id: string;
  readonly name: string;
  readonly login?: CipherLogin | null;
  readonly notes?: string | null;
  readonly fields?: readonly {
    readonly name?: string | null;
    readonly value?: string | null;
    readonly type?: number | null;
  }[];
  readonly deletedAt?: string | null;
}

export interface SyncResponse {
  readonly ciphers: readonly Cipher[];
  readonly profile?: {
    /** 受主密钥保护的对称密钥（Base64 AES-CBC） */
    readonly key?: string | null;
  } | null;
}

export interface PreloginResponse {
  readonly kdf: number;
  readonly kdfIterations: number;
}
