/**
 * KeePassRPC 线协议构造与解析。依据公开协议文档实现（L-3）。
 * 不复制 KeePassXC-Browser 源码；只按文档约定的字段与加密流程写。
 */
import { base64ToBytes, bytesToBase64, incrementNonce } from '../../shared/encoding.js';
import { ERROR_CODES, VaultixError } from '../../shared/errors.js';
import type { KeePassWireResponse } from './types.js';

export function changePublicKeysRequest(
  clientPublicKey: Uint8Array,
  nonce: Uint8Array,
  clientId: string,
): Record<string, unknown> {
  return {
    action: 'change-public-keys',
    publicKey: bytesToBase64(clientPublicKey),
    nonce: bytesToBase64(nonce),
    clientID: clientId,
  };
}

export function encryptedRequest(
  action: string,
  message: string,
  nonce: Uint8Array,
  clientId: string,
): Record<string, unknown> {
  return {
    action,
    message,
    nonce: bytesToBase64(nonce),
    clientID: clientId,
  };
}

/** 协议要求响应 nonce = 请求 nonce + 1 */
export function assertResponseNonce(response: KeePassWireResponse, requestNonce: Uint8Array): void {
  const expected = bytesToBase64(incrementNonce(requestNonce));
  if (response.nonce !== expected) {
    throw new VaultixError(ERROR_CODES.PROTOCOL_MISMATCH);
  }
}

export function isSuccess(value: unknown): boolean {
  return value === true || value === 'true';
}

export function requireSuccess(response: KeePassWireResponse): void {
  if (!isSuccess(response.success)) {
    const code = typeof response.errorCode === 'number' ? response.errorCode : 0;
    throw new VaultixError(
      code === 1
        ? ERROR_CODES.DATABASE_LOCKED
        : code === 6 || code === 19
          ? ERROR_CODES.PERMISSION_DENIED
          : ERROR_CODES.UNKNOWN,
    );
  }
}

export function parseHostPublicKey(response: KeePassWireResponse): Uint8Array {
  const raw = response.publicKey;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new VaultixError(ERROR_CODES.PROTOCOL_MISMATCH);
  }
  return base64ToBytes(raw);
}

/** 把解密后的响应体收敛成确定的对象，禁止把未知字段透给上层 */
export function asPayload(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value };
}
