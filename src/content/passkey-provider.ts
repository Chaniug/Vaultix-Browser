/**
 * 页面主世界的通行密钥提供方（与页面同源的 JS 上下文）。
 *
 * 只做三件事：接管 navigator.credentials、把 WebAuthn 选项转成可传输的 JSON、
 * 把 KeePassXC 返回的 base64 结果还原成浏览器认识的对象。
 * 密码学与存储全部由 KeePassXC 完成（见 docs/08-通行密钥.md）。
 *
 * 铁律：任何不确定的情况都回退到浏览器原生实现——绝不能因为扩展的存在而弄坏网站登录。
 */
import {
  base64UrlToBytes,
  serializeCredentialCreationOptions,
  serializeCredentialRequestOptions,
} from '../core/passkeys.js';

const REQUEST_EVENT = 'vaultix-passkeys-request';
const RESPONSE_EVENT = 'vaultix-passkeys-response';
const AVAILABILITY_TIMEOUT_MS = 800;
const REQUEST_TIMEOUT_MS = 120_000;

interface RelayCredential {
  readonly id?: string;
  readonly type?: string;
  readonly authenticatorAttachment?: string;
  readonly response?: Record<string, unknown>;
  readonly clientExtensionResults?: Record<string, unknown>;
}

interface RelayReply {
  readonly id: string;
  readonly available?: boolean;
  readonly fallback?: boolean;
  readonly errorCode?: number;
  readonly credential?: RelayCredential;
}

interface PendingRequest {
  readonly id: string;
  readonly resolve: (reply: RelayReply | null) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * base64 / base64url → ArrayBuffer。
 * 解码器对两种编码都成立（内部会把 -_ 归一化为 +/），因此不需要区分调用点；
 * 解不出来就返回空缓冲，绝不让格式问题抛异常打断页面。
 */
function toBuffer(encoded: string | undefined): ArrayBuffer {
  if (encoded === undefined) return new ArrayBuffer(0);
  try {
    const bytes = base64UrlToBytes(encoded);
    // 复制到独立 ArrayBuffer：Uint8Array 的 buffer 类型是 ArrayBufferLike，不能直接当 ArrayBuffer 用
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy.buffer;
  } catch {
    return new ArrayBuffer(0);
  }
}

function constructorPrototype(win: Window, name: string): object | undefined {
  const value = (win as unknown as Record<string, unknown>)[name];
  return typeof value === 'function' ? (value as { prototype?: object }).prototype : undefined;
}

function setPrototype<T extends object>(value: T, prototype: object | undefined): T {
  if (prototype !== undefined) {
    try {
      Object.setPrototypeOf(value, prototype);
    } catch {
      // 原型设置失败不影响字段读取，保持普通对象
    }
  }
  return value;
}

function errorFor(code: number | undefined): Error {
  switch (code) {
    case 27:
    case 28:
      return new DOMException('域名与 RP ID 不匹配', 'SecurityError');
    case 29:
    case 34:
    case 35:
      return new DOMException('站点未提供受支持的算法', 'NotSupportedError');
    case 32:
    case 33:
      return new TypeError('WebAuthn 参数无效');
    case 36:
      return new DOMException('凭据未找到', 'SyntaxError');
    default:
      return new DOMException('通行密钥操作被取消或未找到可用凭据', 'NotAllowedError');
  }
}

/**
 * 安装提供方。幂等：重复安装直接返回。
 * 传入 window / document 便于在 jsdom 中测试。
 */
export function installPasskeyProvider(
  win: Window & typeof globalThis = window,
  doc: Document = document,
): void {
  const scope = win as unknown as Record<string, unknown>;
  if (scope.__vaultixPasskeysInstalled === true) return;
  scope.__vaultixPasskeysInstalled = true;

  const pending = new Map<string, PendingRequest>();
  let availableCache: boolean | null = null;

  function nextId(): string {
    if (typeof win.crypto.randomUUID === 'function') return win.crypto.randomUUID();
    return `vpx-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  }

  function ask(
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal | null,
  ): Promise<RelayReply | null> {
    return new Promise((resolve) => {
      const id = nextId();
      let settled = false;
      const finish = (reply: RelayReply | null): void => {
        if (settled) return;
        settled = true;
        pending.delete(id);
        doc.removeEventListener(RESPONSE_EVENT, onReply);
        win.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(reply);
      };
      const onReply = (event: Event): void => {
        const detail = (event as CustomEvent<RelayReply>).detail;
        if (!isRecord(detail) || detail.id !== id) return;
        finish(detail);
      };
      const onAbort = (): void => {
        finish(null);
      };
      const timer = win.setTimeout(() => {
        finish(null);
      }, timeoutMs);

      pending.set(id, { id, resolve: finish });
      doc.addEventListener(RESPONSE_EVENT, onReply);
      signal?.addEventListener('abort', onAbort, { once: true });
      doc.dispatchEvent(new win.CustomEvent(REQUEST_EVENT, { detail: { ...payload, id } }));
    });
  }

  let availabilityPromise: Promise<boolean> | null = null;

  async function detectAvailability(): Promise<boolean> {
    const reply = await ask({ action: 'available' }, AVAILABILITY_TIMEOUT_MS);
    if (reply !== null) {
      availableCache = reply.available === true;
      return availableCache;
    }
    // 站点常在加载时就问「有没有平台验证器」，而中继脚本要到 document_idle 才装好。
    // 文档还没就绪时等一次 DOMContentLoaded 再问，避免把可用性误判成 false 让站点不展示入口。
    if (doc.readyState === 'loading') {
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          resolve();
        };
        doc.addEventListener('DOMContentLoaded', finish, { once: true });
        win.setTimeout(finish, 3000);
      });
      const retry = await ask({ action: 'available' }, AVAILABILITY_TIMEOUT_MS);
      availableCache = retry?.available === true;
      return availableCache;
    }
    availableCache = false;
    return availableCache;
  }

  function isAvailable(): Promise<boolean> {
    if (availableCache !== null) return Promise.resolve(availableCache);
    availabilityPromise ??= detectAvailability();
    return availabilityPromise;
  }

  // jsdom 等环境可能没有 credentials，这里按可选读取并显式判空
  const original = (win.navigator as { credentials?: CredentialsContainer }).credentials;
  if (original === undefined) return;
  // 被提升的内部函数无法沿用上面的空值收窄，显式取一个非空引用
  const credentials = original;

  function buildExtensionResults(raw: RelayCredential): AuthenticationExtensionsClientOutputs {
    return raw.clientExtensionResults ?? {};
  }

  function buildRegistration(raw: RelayCredential): PublicKeyCredential {
    const response = raw.response ?? {};
    const attestationObject = toBuffer(text(response.attestationObject));
    const authenticatorData = toBuffer(text(response.authenticatorData));
    const publicKeyBytes = text(response.publicKey);
    const extensionResults = buildExtensionResults(raw);
    const transports = ['internal'];

    const attestationResponse = setPrototype(
      {
        attestationObject,
        clientDataJSON: toBuffer(text(response.clientDataJSON)),
        getAuthenticatorData: () => authenticatorData,
        getPublicKey: () => (publicKeyBytes === undefined ? null : toBuffer(publicKeyBytes)),
        getPublicKeyAlgorithm: () =>
          typeof response.publicKeyAlgorithm === 'number' ? response.publicKeyAlgorithm : -7,
        getTransports: () => [...transports],
        clientExtensionResults: extensionResults,
      },
      constructorPrototype(win, 'AuthenticatorAttestationResponse'),
    );

    return setPrototype(
      {
        id: text(raw.id) ?? '',
        rawId: toBuffer(text(raw.id)),
        type: 'public-key',
        authenticatorAttachment: raw.authenticatorAttachment ?? 'platform',
        response: attestationResponse,
        getClientExtensionResults: () => extensionResults,
      },
      constructorPrototype(win, 'PublicKeyCredential'),
    ) as unknown as PublicKeyCredential;
  }

  function buildAssertion(raw: RelayCredential): PublicKeyCredential {
    const response = raw.response ?? {};
    const userHandle = text(response.userHandle);
    const extensionResults = buildExtensionResults(raw);

    const assertionResponse = setPrototype(
      {
        authenticatorData: toBuffer(text(response.authenticatorData)),
        clientDataJSON: toBuffer(text(response.clientDataJSON)),
        signature: toBuffer(text(response.signature)),
        userHandle: userHandle === undefined ? null : toBuffer(userHandle),
        clientExtensionResults: extensionResults,
      },
      constructorPrototype(win, 'AuthenticatorAssertionResponse'),
    );

    return setPrototype(
      {
        id: text(raw.id) ?? '',
        rawId: toBuffer(text(raw.id)),
        type: 'public-key',
        authenticatorAttachment: raw.authenticatorAttachment ?? 'platform',
        response: assertionResponse,
        getClientExtensionResults: () => extensionResults,
      },
      constructorPrototype(win, 'PublicKeyCredential'),
    ) as unknown as PublicKeyCredential;
  }

  async function createCredential(
    options: CredentialCreationOptions | undefined,
  ): Promise<Credential | null> {
    if (options?.publicKey === undefined) return credentials.create(options);
    const serialized = serializeCredentialCreationOptions(options.publicKey);
    if (serialized === null || !(await isAvailable())) return credentials.create(options);

    const reply = await ask(
      { action: 'register', options: serialized },
      REQUEST_TIMEOUT_MS,
      options.signal,
    );
    if (reply === null || reply.fallback === true) return credentials.create(options);
    if (reply.credential === undefined) throw errorFor(reply.errorCode);
    return buildRegistration(reply.credential);
  }

  async function getCredential(
    options: CredentialRequestOptions | undefined,
  ): Promise<Credential | null> {
    if (options?.publicKey === undefined) return credentials.get(options);
    if (options.mediation === 'conditional') return credentials.get(options);
    if (options.mediation === 'silent') return null;
    const serialized = serializeCredentialRequestOptions(options.publicKey);
    if (serialized === null || !(await isAvailable())) return credentials.get(options);

    const reply = await ask(
      { action: 'get', options: serialized },
      REQUEST_TIMEOUT_MS,
      options.signal,
    );
    if (reply === null || reply.fallback === true) return credentials.get(options);
    if (reply.credential === undefined) throw errorFor(reply.errorCode);
    return buildAssertion(reply.credential);
  }

  const provider = {
    create: createCredential,
    get: getCredential,
    store: async (credential: Credential): Promise<Credential | null> => {
      if (typeof credentials.store === 'function') await credentials.store(credential);
      return credential;
    },
    preventSilentAccess: async (): Promise<void> => {
      if (typeof credentials.preventSilentAccess === 'function')
        await credentials.preventSilentAccess();
    },
  };

  try {
    Object.defineProperty(win.navigator, 'credentials', { configurable: true, value: provider });
  } catch {
    return;
  }

  // 让站点认为本机存在「平台验证器」，否则大多数站点不会展示通行密钥入口
  const pkCtor = (win as unknown as Record<string, unknown>).PublicKeyCredential;
  if (typeof pkCtor === 'function') {
    const pk = pkCtor as unknown as Record<string, unknown>;
    const originalUvpaa = pk.isUserVerifyingPlatformAuthenticatorAvailable;
    Object.defineProperty(pk, 'isUserVerifyingPlatformAuthenticatorAvailable', {
      configurable: true,
      value: async (): Promise<boolean> => {
        if (await isAvailable()) return true;
        if (typeof originalUvpaa === 'function') {
          try {
            return await (originalUvpaa as () => Promise<boolean>)();
          } catch {
            return false;
          }
        }
        return false;
      },
    });
    Object.defineProperty(pk, 'isConditionalMediationAvailable', {
      configurable: true,
      value: () => Promise.resolve(false),
    });
  }
}
