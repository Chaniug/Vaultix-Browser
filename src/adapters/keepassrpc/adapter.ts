/**
 * KeePassRPC 适配器：associate → get-logins → get-totp；P4 起支持 set-login（DEC-010）。
 *
 * 协议依据公开文档实现（L-3），不复制上游源码。
 * 设计纪律：search / listAll 不向调用方抛异常；所有错误收敛为错误码（S-2）。
 */
import type {
  BackendAdapter,
  BackendCapabilities,
  CredentialDraft,
  CredentialItem,
  SaveResult,
  SearchQuery,
} from '../../core/types.js';
import { base64ToBytes, bytesToBase64 } from '../../shared/encoding.js';
import { versionAtLeast } from '../../core/passkeys.js';
import { ERROR_CODES, toErrorCode, VaultixError } from '../../shared/errors.js';
import { logDebug, logWarn } from '../../shared/logger.js';
import {
  changePublicKeysRequest,
  encryptedRequest,
  errorCodeOf,
  isSuccess,
  parseHostPublicKey,
  requireSuccess,
} from './protocol.js';
import {
  createClientKeyPair,
  createIdentificationKeyPair,
  open,
  randomClientId,
  randomNonce,
  seal,
} from './crypto.js';
import type { SessionKeys } from './crypto.js';
import {
  KEEPASS_ERROR_NO_MATCH,
  type KeePassAssociation,
  type KeePassEntry,
  type KeePassRpcConfig,
  type KeePassWireResponse,
  type NativeTransport,
} from './types.js';

const CAPABILITIES: BackendCapabilities = {
  search: true,
  // 公开协议只能列组（get-database-groups），无法可靠枚举全部条目；
  // 按 C-3 不提供"半个适配器"，故显式声明不支持 listAll。
  listAll: false,
  totp: true,
  customFields: false,
  uriMatching: false,
  write: true,
};

interface SessionState {
  keys: SessionKeys | null;
  association: KeePassAssociation | null;
  clientId: string;
  ready: boolean;
  /** KeePassXC 版本，来自 change-public-keys 响应；用于能力判断 */
  hostVersion: string | null;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

function asEntries(value: unknown): readonly KeePassEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is KeePassEntry => {
    if (typeof item !== 'object' || item === null) return false;
    const entry = item as Record<string, unknown>;
    return (
      typeof entry.login === 'string' &&
      typeof entry.password === 'string' &&
      typeof entry.name === 'string'
    );
  });
}

export class KeePassRpcAdapter implements BackendAdapter {
  readonly source = 'keepassxc' as const;
  readonly capabilities = CAPABILITIES;

  private readonly state: SessionState;

  constructor(
    private readonly transport: NativeTransport,
    config: KeePassRpcConfig = {},
  ) {
    this.state = {
      keys: null,
      association: config.association ?? null,
      clientId: config.clientId ?? randomClientId(),
      ready: false,
      hostVersion: null,
    };
  }

  isReady(): boolean {
    return this.state.ready && this.transport.connected;
  }

  /** 握手 + 已有配对校验。失败不抛到调用方，由 isReady() 体现。 */
  async initialize(): Promise<void> {
    const started = Date.now();
    try {
      await this.ensureHandshake();
      if (this.state.association) {
        await this.testAssociate();
      }
      logDebug('keepassrpc.initialize', {
        backend: 'keepassxc',
        ok: this.state.ready,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      this.state.ready = false;
      logWarn('keepassrpc.initialize.failed', {
        backend: 'keepassxc',
        code: toErrorCode(error),
      });
    }
  }

  /** 首次配对；需用户在 KeePassXC 弹窗中确认。成功后返回应持久化的配对信息。 */
  async associate(): Promise<KeePassAssociation> {
    await this.ensureHandshake();
    const keys = this.state.keys;
    if (!keys) throw new Error('handshake required');
    const identification = createIdentificationKeyPair();
    const payload = {
      action: 'associate',
      key: bytesToBase64(keys.clientKeyPair.publicKey),
      idKey: bytesToBase64(identification.publicKey),
    };
    const response = await this.call('associate', payload);
    const id = response.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('association id missing');
    }
    const association: KeePassAssociation = {
      id,
      key: bytesToBase64(identification.publicKey),
    };
    this.state.association = association;
    this.state.ready = true;
    return association;
  }

  /** KeePassXC 2.7.7 起支持通行密钥 */
  supportsPasskeys(): boolean {
    return this.state.ready && versionAtLeast(this.state.hostVersion, 2, 7, 7);
  }

  async passkeysRegister(
    publicKey: Record<string, unknown>,
    origin: string,
  ): Promise<Record<string, unknown>> {
    return this.passkeyCall('passkeys-register', publicKey, origin);
  }

  async passkeysGet(
    publicKey: Record<string, unknown>,
    origin: string,
  ): Promise<Record<string, unknown>> {
    return this.passkeyCall('passkeys-get', publicKey, origin);
  }

  /**
   * 通行密钥的密码学与存储由 KeePassXC 完成（见 docs/08-通行密钥.md）。
   * 内层必须带 action / publicKey / origin / keys；返回其 response 对象：
   * 成功时是 PublicKeyCredential JSON，失败时是 { errorCode }。
   */
  private async passkeyCall(
    action: 'passkeys-register' | 'passkeys-get',
    publicKey: Record<string, unknown>,
    origin: string,
  ): Promise<Record<string, unknown>> {
    const association = this.state.association;
    if (association === null) throw new VaultixError(ERROR_CODES.ASSOCIATION_REQUIRED);
    const response = await this.call(
      action,
      {
        action,
        publicKey,
        origin,
        relatedOrigins: [],
        keys: [{ id: association.id, key: association.key }],
      },
      { allowProtocolError: true },
    );
    // 外层或内层都可能带回 errorCode：统一成 { errorCode } 交给页面映射
    const outerCode = response.errorCode;
    if (outerCode !== undefined && response.response === undefined) {
      return { errorCode: outerCode };
    }
    const payload = response.response;
    if (typeof payload !== 'object' || payload === null) {
      throw new VaultixError(ERROR_CODES.PROTOCOL_MISMATCH);
    }
    return payload as Record<string, unknown>;
  }

  async search(query: SearchQuery): Promise<readonly CredentialItem[]> {
    const started = Date.now();
    try {
      if (!this.isReady()) return [];
      const association = this.state.association;
      if (!association) return [];

      const payload: Record<string, unknown> = {
        action: 'get-logins',
        url: query.url,
        keys: [{ id: association.id, key: association.key }],
      };
      if (query.submitUrl !== undefined) payload.submitUrl = query.submitUrl;
      if (query.httpAuth !== undefined) {
        payload.httpAuth = query.httpAuth ? 'true' : 'false';
      }

      const response = await this.call('get-logins', payload, {
        allowNoMatch: true,
      });
      const entries = asEntries(response.entries);
      const items: CredentialItem[] = [];
      for (const entry of entries) {
        items.push(await this.toCredentialItem(entry, response));
      }
      logDebug('keepassrpc.search', {
        backend: 'keepassxc',
        ok: true,
        durationMs: Date.now() - started,
      });
      return items;
    } catch (error) {
      logWarn('keepassrpc.search.failed', {
        backend: 'keepassxc',
        code: toErrorCode(error),
      });
      return [];
    }
  }

  listAll(): Promise<readonly CredentialItem[]> {
    // capabilities.listAll === false，按契约返回空数组（C-3）
    return Promise.resolve([]);
  }

  /** 单独取 TOTP。失败返回 undefined，不抛异常。 */
  async getTotp(uuid: string): Promise<string | undefined> {
    try {
      if (!this.isReady()) return undefined;
      const response = await this.call('get-totp', { action: 'get-totp', uuid });
      return typeof response.totp === 'string' ? response.totp : undefined;
    } catch (error) {
      logWarn('keepassrpc.totp.failed', {
        backend: 'keepassxc',
        code: toErrorCode(error),
      });
      return undefined;
    }
  }

  /**
   * 写回凭证（DEC-010）：set-login 新建（uuid 为空）或更新（带 uuid）。
   * 按公开协议发送，不复制上游源码（L-3）。
   */
  async save(draft: CredentialDraft): Promise<SaveResult> {
    const started = Date.now();
    try {
      if (!this.isReady()) {
        throw new Error('adapter not ready');
      }
      const association = this.state.association;
      if (!association) throw new Error('association required');

      const payload: Record<string, unknown> = {
        action: 'set-login',
        url: draft.url,
        login: draft.username,
        password: draft.password,
        id: association.id,
      };
      if (draft.uuid !== undefined && draft.uuid.length > 0) {
        payload.uuid = draft.uuid;
      }
      if (draft.folder !== undefined && draft.folder.length > 0) {
        payload.group = draft.folder;
      }
      // 协议文档中的可选字段，空串表示不指定
      payload.submitUrl = '';
      payload.groupUuid = '';
      payload.downloadFavicon = 'false';

      const response = await this.call('set-login', payload);
      const created = draft.uuid === undefined || draft.uuid.length === 0;
      const returnedUuid = typeof response.uuid === 'string' ? response.uuid : undefined;
      logDebug('keepassrpc.save', {
        backend: 'keepassxc',
        ok: true,
        durationMs: Date.now() - started,
      });
      return {
        ok: true,
        source: 'keepassxc',
        ...(returnedUuid !== undefined ? { id: returnedUuid } : {}),
        created,
      };
    } catch (error) {
      logWarn('keepassrpc.save.failed', {
        backend: 'keepassxc',
        code: toErrorCode(error),
      });
      return { ok: false, source: 'keepassxc' };
    }
  }

  private async toCredentialItem(
    entry: KeePassEntry,
    response: Record<string, unknown>,
  ): Promise<CredentialItem> {
    const uuid = typeof entry.uuid === 'string' ? entry.uuid : undefined;
    const id = uuid ?? `${entry.name}|${entry.login}`;
    let totp = typeof entry.totp === 'string' ? entry.totp : undefined;
    if (totp === undefined && uuid !== undefined) {
      totp = await this.getTotp(uuid);
    }
    const expired = parseBoolean(entry.expired);
    const meta: Record<string, unknown> = {};
    if (typeof response.hash === 'string') meta.databaseHash = response.hash;
    if (typeof response.version === 'string') meta.version = response.version;

    return {
      id,
      source: 'keepassxc',
      name: entry.name,
      username: entry.login,
      password: entry.password,
      ...(totp !== undefined ? { totp } : {}),
      ...(expired !== undefined ? { expired } : {}),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    };
  }

  private async testAssociate(): Promise<void> {
    const association = this.state.association;
    if (!association) return;
    const response = await this.call('test-associate', {
      action: 'test-associate',
      id: association.id,
      key: association.key,
    });
    this.state.ready = isSuccess(response.success);
  }

  private async ensureHandshake(): Promise<void> {
    if (this.state.keys && this.transport.connected) return;
    if (!this.transport.connected) {
      // 端口已断（service worker 存活期间 KeePassXC 重启 / 浏览器回收端口）：
      // 旧会话密钥随之作废，必须重新握手，不能沿用 state.keys
      this.state.keys = null;
      this.state.ready = false;
      await this.transport.connect();
    }
    const clientKeyPair = createClientKeyPair();
    const nonce = randomNonce();
    const wire = await this.transport.send(
      changePublicKeysRequest(clientKeyPair.publicKey, nonce, this.state.clientId),
    );
    requireSuccess(wire);
    const hostPublicKey = parseHostPublicKey(wire);
    this.state.hostVersion = typeof wire.version === 'string' ? wire.version : null;
    this.state.keys = { clientKeyPair, hostPublicKey, nonce };
    logDebug('keepassrpc.handshake', { backend: 'keepassxc', ok: true });
  }

  /**
   * 串行加密调用：请求 nonce 用于封箱，响应 nonce 由服务端另行生成。
   * 真实 KeePassXC（2.8 实测）用「响应 nonce」加密 message，且该 nonce 不是请求 nonce + 1。
   */
  private async call(
    action: string,
    payload: Record<string, unknown>,
    options: { allowNoMatch?: boolean; allowProtocolError?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const keys = this.state.keys;
    if (!keys) throw new Error('handshake required');

    const nonce = randomNonce();
    const message = seal(payload, keys.hostPublicKey, keys.clientKeyPair.secretKey, nonce);
    const wire: KeePassWireResponse = await this.transport.send(
      encryptedRequest(action, message, nonce, this.state.clientId),
    );

    if (typeof wire.message !== 'string') {
      // 通行密钥的错误走未加密的外层回复（实测 2.8.0：errorCode 为字符串），
      // 必须原样带回，否则页面只能拿到一个笼统的失败
      if (options.allowProtocolError === true) {
        const code = errorCodeOf(wire.errorCode);
        return code > 0 ? { errorCode: code } : {};
      }
      if (errorCodeOf(wire.errorCode) === KEEPASS_ERROR_NO_MATCH && options.allowNoMatch) {
        return {};
      }
      requireSuccess(wire);
      throw new Error('missing encrypted payload');
    }
    if (typeof wire.nonce !== 'string' || wire.nonce.length === 0) {
      throw new VaultixError(ERROR_CODES.PROTOCOL_MISMATCH);
    }
    const responseNonce = base64ToBytes(wire.nonce);
    const decrypted = open(
      wire.message,
      keys.hostPublicKey,
      keys.clientKeyPair.secretKey,
      responseNonce,
    );
    if (!isSuccess(decrypted.success)) {
      if (errorCodeOf(decrypted.errorCode) === KEEPASS_ERROR_NO_MATCH && options.allowNoMatch) {
        return decrypted;
      }
      requireSuccess(decrypted);
    }
    return decrypted;
  }
}
