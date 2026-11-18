/**
 * KeePassRPC 适配器：associate → get-logins → get-totp。
 *
 * 协议依据公开文档实现（L-3），不复制上游源码。
 * 设计纪律：search / listAll 不向调用方抛异常；所有错误收敛为错误码（S-2）。
 */
import type {
  BackendAdapter,
  BackendCapabilities,
  CredentialItem,
  SearchQuery,
} from '../../core/types.js';
import { bytesToBase64 } from '../../shared/encoding.js';
import { toErrorCode } from '../../shared/errors.js';
import { logDebug, logWarn } from '../../shared/logger.js';
import {
  changePublicKeysRequest,
  encryptedRequest,
  isSuccess,
  parseHostPublicKey,
  requireSuccess,
  assertResponseNonce,
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
  write: false,
};

interface SessionState {
  keys: SessionKeys | null;
  association: KeePassAssociation | null;
  clientId: string;
  ready: boolean;
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
    if (this.state.keys) return;
    await this.transport.connect();
    const clientKeyPair = createClientKeyPair();
    const nonce = randomNonce();
    const wire = await this.transport.send(
      changePublicKeysRequest(clientKeyPair.publicKey, nonce, this.state.clientId),
    );
    requireSuccess(wire);
    const hostPublicKey = parseHostPublicKey(wire);
    this.state.keys = { clientKeyPair, hostPublicKey, nonce };
    logDebug('keepassrpc.handshake', { backend: 'keepassxc', ok: true });
  }

  /** 串行加密调用：noce 每次随机，响应 nonce 必须为请求 nonce + 1。 */
  private async call(
    action: string,
    payload: Record<string, unknown>,
    options: { allowNoMatch?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const keys = this.state.keys;
    if (!keys) throw new Error('handshake required');

    const nonce = randomNonce();
    const message = seal(payload, keys.hostPublicKey, keys.clientKeyPair.secretKey, nonce);
    const wire: KeePassWireResponse = await this.transport.send(
      encryptedRequest(action, message, nonce, this.state.clientId),
    );
    assertResponseNonce(wire, nonce);

    if (typeof wire.message !== 'string') {
      if (wire.errorCode === KEEPASS_ERROR_NO_MATCH && options.allowNoMatch) {
        return {};
      }
      requireSuccess(wire);
      throw new Error('missing encrypted payload');
    }

    const decrypted = open(wire.message, keys.hostPublicKey, keys.clientKeyPair.secretKey, nonce);
    if (!isSuccess(decrypted.success)) {
      if (decrypted.errorCode === KEEPASS_ERROR_NO_MATCH && options.allowNoMatch) {
        return decrypted;
      }
      requireSuccess(decrypted);
    }
    return decrypted;
  }
}
