import nacl from 'tweetnacl';
import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from '../../shared/encoding.js';
import { ERROR_CODES, VaultixError } from '../../shared/errors.js';

export interface SessionKeys {
  readonly clientKeyPair: nacl.BoxKeyPair;
  readonly hostPublicKey: Uint8Array;
  readonly nonce: Uint8Array;
}

export function createClientKeyPair(): nacl.BoxKeyPair {
  return nacl.box.keyPair();
}

export function createIdentificationKeyPair(): nacl.BoxKeyPair {
  return nacl.box.keyPair();
}

export function randomNonce(): Uint8Array {
  return nacl.randomBytes(nacl.box.nonceLength);
}

export function randomClientId(): string {
  return bytesToBase64(nacl.randomBytes(24));
}

/** 用 recipient 公钥 + sender 私钥封箱，返回 base64 */
export function seal(
  payload: Record<string, unknown>,
  recipientPublicKey: Uint8Array,
  senderSecretKey: Uint8Array,
  nonce: Uint8Array,
): string {
  const boxed = nacl.box(
    utf8ToBytes(JSON.stringify(payload)),
    nonce,
    recipientPublicKey,
    senderSecretKey,
  );
  return bytesToBase64(boxed);
}

/** 用 recipient 私钥 + sender 公钥开箱，解析 JSON */
export function open(
  message: string,
  senderPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array,
  nonce: Uint8Array,
): Record<string, unknown> {
  const opened = nacl.box.open(base64ToBytes(message), nonce, senderPublicKey, recipientSecretKey);
  if (!opened) throw new VaultixError(ERROR_CODES.DECRYPT_FAILED);
  try {
    const parsed: unknown = JSON.parse(bytesToUtf8(opened));
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new VaultixError(ERROR_CODES.PROTOCOL_MISMATCH);
  }
}
