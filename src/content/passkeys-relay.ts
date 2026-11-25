/**
 * 通行密钥中继（隔离世界）。
 *
 * 主世界的提供方无法调用扩展 API，所以由这里把请求转给 background，
 * 再把结果派发回主世界。origin 不在这里传：后台一律以消息发送者的 URL 为准，
 * 避免页面伪造一个别的域名来索取通行密钥。
 */
import { MSG } from '../shared/messages.js';

const REQUEST_EVENT = 'vaultix-passkeys-request';
const RESPONSE_EVENT = 'vaultix-passkeys-response';

interface PasskeyReply {
  readonly ok: boolean;
  readonly fallback?: boolean;
  readonly credential?: Record<string, unknown>;
  readonly errorCode?: number;
}

async function handle(detail: Record<string, unknown>, id: string, doc: Document): Promise<void> {
  const reply = (payload: Record<string, unknown>): void => {
    doc.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail: { id, ...payload } }));
  };

  const action = detail.action;
  try {
    if (action === 'available') {
      const response = (await chrome.runtime.sendMessage({
        type: MSG.PASSKEY_AVAILABLE,
      })) as { available?: boolean } | null;
      reply({ available: response?.available === true });
      return;
    }
    if (action !== 'register' && action !== 'get') return;

    const options = detail.options;
    if (typeof options !== 'object' || options === null) {
      reply({ fallback: true });
      return;
    }
    const response = (await chrome.runtime.sendMessage({
      type: action === 'register' ? MSG.PASSKEY_REGISTER : MSG.PASSKEY_GET,
      options,
    })) as unknown as PasskeyReply | null;

    if (response === null) {
      reply({ fallback: true });
      return;
    }
    if (response.ok && response.credential !== undefined) {
      reply({ credential: response.credential });
      return;
    }
    if (response.fallback === true) {
      reply({ fallback: true });
      return;
    }
    reply({ errorCode: response.errorCode ?? 31 });
  } catch {
    // 扩展被重新加载 / 后台不可用：交回浏览器原生实现，绝不卡住站点
    reply({ fallback: true });
  }
}

/** 安装中继；与 content script 的启动保护一起保证每个 frame 只装一次 */
export function startPasskeysRelay(doc: Document = document): void {
  doc.addEventListener(REQUEST_EVENT, (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== 'object' || detail === null) return;
    const request = detail as Record<string, unknown>;
    const id = typeof request.id === 'string' ? request.id : '';
    if (id.length === 0) return;
    void handle(request, id, doc);
  });
}
