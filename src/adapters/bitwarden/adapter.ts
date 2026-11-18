/**
 * Bitwarden 适配器：登录 → sync → 解密 → 列表/搜索；P4 起支持写回（DEC-010）。
 * 官方云与 Vaultwarden 共用本实现，仅 endpoints 不同（DEC-002 / T-2）。
 */
import type {
  BackendAdapter,
  BackendCapabilities,
  CredentialDraft,
  CredentialItem,
  CredentialUri,
  CustomField,
  CustomFieldType,
  SaveResult,
  SearchQuery,
  UriMatchType,
} from '../../core/types.js';
import { bytesToBase64, base64ToBytes } from '../../shared/encoding.js';
import { ERROR_CODES, VaultixError, toErrorCode } from '../../shared/errors.js';
import { logDebug, logWarn } from '../../shared/logger.js';
import { redactDomain } from '../../shared/url.js';
import { BitwardenClient, requestHostPermission } from './client-api.js';
import {
  decryptCipherString,
  decryptSymmetricKey,
  deriveMasterKey,
  deriveStretchedKey,
  encryptCipherString,
} from './crypto.js';
import type { BitwardenConfig, Cipher, TokenResponse } from './types.js';

const CAPABILITIES: BackendCapabilities = {
  search: true,
  listAll: true,
  totp: true,
  customFields: true,
  uriMatching: true,
  write: true,
};

interface Session {
  readonly token: string;
  readonly refreshToken?: string;
  readonly symmetricKey: Uint8Array;
}

export interface BitwardenSessionSnapshot {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Base64 对称密钥；仅允许写入 chrome.storage.session（S-1） */
  readonly symmetricKey: string;
}

const MATCH_TYPE_MAP: Readonly<Record<number, UriMatchType>> = {
  0: 'domain',
  1: 'host',
  2: 'exact',
  3: 'startsWith',
  4: 'regex',
  5: 'never',
};

const FIELD_TYPE_MAP: Readonly<Record<number, CustomFieldType>> = {
  0: 'text',
  1: 'hidden',
  2: 'boolean',
  3: 'linked',
};

function uriMatches(uri: string, match: UriMatchType | undefined, url: string): boolean {
  const strategy = match ?? 'domain';
  if (strategy === 'never') return false;
  try {
    const target = new URL(url);
    if (strategy === 'exact') return uri === url;
    if (strategy === 'startsWith') return url.startsWith(uri);
    if (strategy === 'regex') {
      // 用户配置的正则属于数据；限制长度并捕获语法错误，避免异常外泄（S-2）
      if (uri.length > 256) return false;
      return new RegExp(uri).test(url);
    }
    const source = new URL(uri);
    if (strategy === 'host') return source.hostname === target.hostname;
    return redactDomain(source.href) === redactDomain(target.href);
  } catch {
    return false;
  }
}

function asNonEmptyString(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class BitwardenAdapter implements BackendAdapter {
  readonly source = 'bitwarden' as const;
  readonly capabilities = CAPABILITIES;

  private readonly client: BitwardenClient;
  private session: Session | null = null;
  private cache: { readonly at: number; readonly ciphers: readonly Cipher[] } | null = null;

  constructor(
    private readonly config: BitwardenConfig,
    client?: BitwardenClient,
  ) {
    this.client =
      client ??
      new BitwardenClient(config.serverUrl, config.mode, {
        requestPermission: requestHostPermission,
      });
    const token = config.accessToken;
    const symmetric = config.symmetricKey;
    if (token !== undefined && symmetric !== undefined) {
      this.session = {
        token,
        ...(config.refreshToken !== undefined ? { refreshToken: config.refreshToken } : {}),
        symmetricKey: base64ToBytes(symmetric),
      };
    }
  }

  isReady(): boolean {
    return this.session !== null;
  }

  /** 会话快照仅用于 chrome.storage.session，不落盘（S-1） */
  exportSession(): BitwardenSessionSnapshot | null {
    if (!this.session) return null;
    return {
      accessToken: this.session.token,
      symmetricKey: bytesToBase64(this.session.symmetricKey),
      ...(this.session.refreshToken !== undefined
        ? { refreshToken: this.session.refreshToken }
        : {}),
    };
  }

  /** 登录 + 派生密钥。主密码只在调用期间驻留内存，绝不写盘。 */
  async login(): Promise<void> {
    const started = Date.now();
    try {
      if (this.session) return;
      const email = this.config.email;
      const masterPassword = this.config.masterPassword;
      if (!email || !masterPassword) {
        throw new VaultixError(ERROR_CODES.INVALID_CREDENTIALS);
      }

      const prelogin = await this.client.prelogin(email);
      const iterations = this.config.kdfIterations ?? prelogin.kdfIterations;
      const masterKey = await deriveMasterKey(email, masterPassword, iterations);
      const stretchedKey = await deriveStretchedKey(masterKey, masterPassword, iterations);
      const token = await this.client.loginWithPassword(
        email,
        bytesToBase64(stretchedKey),
        this.config.twoFactorCode,
      );
      const sync = await this.client.sync(token.access_token);
      const protectedKey = asNonEmptyString(sync.profile?.key);
      if (protectedKey === undefined) {
        throw new VaultixError(ERROR_CODES.DECRYPT_FAILED);
      }
      const symmetricKey = await decryptSymmetricKey(protectedKey, masterKey);
      this.session = {
        token: token.access_token,
        ...(token.refresh_token !== undefined ? { refreshToken: token.refresh_token } : {}),
        symmetricKey,
      };
      this.cache = { at: Date.now(), ciphers: sync.ciphers };
      logDebug('bitwarden.login', {
        backend: 'bitwarden',
        ok: true,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      logWarn('bitwarden.login.failed', {
        backend: 'bitwarden',
        code: toErrorCode(error),
      });
      throw error;
    }
  }

  async search(query: SearchQuery): Promise<readonly CredentialItem[]> {
    try {
      if (!this.isReady()) return [];
      const items = await this.allItems();
      return items.filter((item) => {
        const uris = item.uris ?? [];
        if (uris.length === 0) return false;
        return uris.some((entry) => uriMatches(entry.uri, entry.match, query.url));
      });
    } catch (error) {
      logWarn('bitwarden.search.failed', {
        backend: 'bitwarden',
        code: toErrorCode(error),
      });
      return [];
    }
  }

  async listAll(): Promise<readonly CredentialItem[]> {
    try {
      if (!this.isReady()) return [];
      return await this.allItems();
    } catch (error) {
      logWarn('bitwarden.listAll.failed', {
        backend: 'bitwarden',
        code: toErrorCode(error),
      });
      return [];
    }
  }

  lock(): void {
    this.session = null;
    this.cache = null;
  }

  /** 写回凭证（DEC-010）：新建或更新 Cipher；失败收敛为 ok:false，不抛异常 */
  async save(draft: CredentialDraft): Promise<SaveResult> {
    const started = Date.now();
    try {
      const session = this.session;
      if (!session) throw new VaultixError(ERROR_CODES.BACKEND_NOT_READY);
      const key = session.symmetricKey;

      const hostname = safeHostname(draft.url);
      const name = await encryptCipherString(draft.name ?? hostname, key);
      const uri = await encryptCipherString(draft.url, key);
      const username = await encryptCipherString(draft.username, key);
      const password = await encryptCipherString(draft.password, key);

      const body: Record<string, unknown> = {
        type: 1,
        name,
        login: { uris: [{ uri, match: null }], username, password },
        notes: null,
        fields: [],
        folderId: null,
        organizationId: null,
      };
      const updateId = draft.uuid !== undefined && draft.uuid.length > 0 ? draft.uuid : null;
      if (updateId !== null) {
        body.id = updateId;
        await this.client.updateCipher(session.token, updateId, body);
      } else {
        const created = await this.client.createCipher(session.token, body);
        this.cache = null;
        return {
          ok: true,
          source: 'bitwarden',
          id: created.id,
          created: true,
        };
      }
      this.cache = null;
      logDebug('bitwarden.save', {
        backend: 'bitwarden',
        ok: true,
        durationMs: Date.now() - started,
      });
      return { ok: true, source: 'bitwarden', id: updateId, created: false };
    } catch (error) {
      logWarn('bitwarden.save.failed', {
        backend: 'bitwarden',
        code: toErrorCode(error),
      });
      return { ok: false, source: 'bitwarden' };
    }
  }

  private async allItems(): Promise<readonly CredentialItem[]> {
    const ciphers = await this.getCiphers();
    const session = this.session;
    if (!session) return [];
    const out: CredentialItem[] = [];
    for (const cipher of ciphers) {
      if (cipher.deletedAt != null) continue;
      try {
        out.push(await this.toCredentialItem(cipher, session.symmetricKey));
      } catch {
        // 单条解密失败跳过，不影响其他条目（T-1 容错）
        logWarn('bitwarden.cipher.skip', {
          backend: 'bitwarden',
          code: ERROR_CODES.DECRYPT_FAILED,
        });
      }
    }
    return out;
  }

  private async getCiphers(): Promise<readonly Cipher[]> {
    if (this.cache && Date.now() - this.cache.at < 60_000) {
      return this.cache.ciphers;
    }
    const session = this.session;
    if (!session) throw new VaultixError(ERROR_CODES.BACKEND_NOT_READY);
    try {
      const sync = await this.client.sync(session.token);
      this.cache = { at: Date.now(), ciphers: sync.ciphers };
      return sync.ciphers;
    } catch (error) {
      if (
        error instanceof VaultixError &&
        error.code === ERROR_CODES.PERMISSION_DENIED &&
        session.refreshToken !== undefined
      ) {
        const refreshed = await this.client.refreshToken(session.refreshToken);
        this.session = this.withRefreshedToken(session, refreshed);
        const sync = await this.client.sync(refreshed.access_token);
        this.cache = { at: Date.now(), ciphers: sync.ciphers };
        return sync.ciphers;
      }
      throw error;
    }
  }

  private withRefreshedToken(session: Session, token: TokenResponse): Session {
    return {
      token: token.access_token,
      symmetricKey: session.symmetricKey,
      ...(token.refresh_token !== undefined
        ? { refreshToken: token.refresh_token }
        : session.refreshToken !== undefined
          ? { refreshToken: session.refreshToken }
          : {}),
    };
  }

  private async toCredentialItem(cipher: Cipher, key: Uint8Array): Promise<CredentialItem> {
    const login = cipher.login;
    const name = await decryptText(cipher.name, key);
    const username = await decryptText(login?.username, key);
    const password = await decryptText(login?.password, key);
    const totp = await decryptText(login?.totp, key);
    const notes = await decryptText(cipher.notes, key);

    const uris: CredentialUri[] = [];
    for (const uri of login?.uris ?? []) {
      const value = await decryptText(uri.uri, key);
      if (value.length === 0) continue;
      const match = typeof uri.match === 'number' ? MATCH_TYPE_MAP[uri.match] : undefined;
      uris.push(match === undefined ? { uri: value } : { uri: value, match });
    }

    const customFields: CustomField[] = [];
    for (const field of cipher.fields ?? []) {
      const fieldName = await decryptText(field.name, key);
      const fieldValue = await decryptText(field.value, key);
      if (fieldName.length === 0) continue;
      const type = typeof field.type === 'number' ? FIELD_TYPE_MAP[field.type] : undefined;
      customFields.push({
        name: fieldName,
        value: fieldValue,
        type: type ?? 'text',
      });
    }

    return {
      id: cipher.id,
      source: 'bitwarden',
      name,
      username,
      password,
      ...(totp.length > 0 ? { totp } : {}),
      ...(uris.length > 0 ? { uris } : {}),
      ...(customFields.length > 0 ? { customFields } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };
  }
}

async function decryptText(value: string | null | undefined, key: Uint8Array): Promise<string> {
  const text = asNonEmptyString(value);
  if (text === undefined) return '';
  return decryptCipherString(text, key);
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname || 'Untitled';
  } catch {
    return 'Untitled';
  }
}
