/**
 * 稳定错误码。S-2/S-7：错误上报只允许错误码，不含完整 URL、条目名、用户名。
 */
export const ERROR_CODES = {
  BACKEND_NOT_READY: 'BACKEND_NOT_READY',
  ASSOCIATION_REQUIRED: 'ASSOCIATION_REQUIRED',
  DATABASE_LOCKED: 'DATABASE_LOCKED',
  NATIVE_PROXY_MISSING: 'NATIVE_PROXY_MISSING',
  PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
  DECRYPT_FAILED: 'DECRYPT_FAILED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TWO_FACTOR_REQUIRED: 'TWO_FACTOR_REQUIRED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class VaultixError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message?: string) {
    // 消息仅用于开发排查；对外只暴露 code，绝不拼入用户数据
    super(message ?? code);
    this.name = 'VaultixError';
    this.code = code;
  }
}

/** 把任意异常收敛成稳定错误码，避免原始 message 泄露到日志/遥测 */
export function toErrorCode(error: unknown): ErrorCode {
  if (error instanceof VaultixError) return error.code;
  return ERROR_CODES.UNKNOWN;
}
