/** KeePassRPC 类型。协议依据公开文档 keepassxc-protocol.md（L-3：不复制上游源码）。 */

export interface KeePassAssociation {
  /** 数据库侧分配的客户端标识 */
  readonly id: string;
  /** 身份公钥（base64）。只保存公钥，私钥不落盘也不导出（协议仅用公钥识别） */
  readonly key: string;
}

export interface KeePassRpcConfig {
  /** 单次会话标识，24 字节随机 base64 */
  readonly clientId?: string;
  /** 已配对信息；首次使用前为 null */
  readonly association?: KeePassAssociation | null;
  /** 请求超时，默认 8000ms */
  readonly timeoutMs?: number;
}

export interface KeePassEntry {
  readonly uuid?: string;
  readonly name: string;
  readonly login: string;
  readonly password: string;
  readonly expired?: string | boolean;
  readonly totp?: string;
}

export type KeePassWireResponse = Record<string, unknown> & {
  readonly success?: string | boolean;
  readonly error?: string;
  readonly errorCode?: number;
};

export interface NativeTransport {
  readonly connected: boolean;
  connect(): Promise<void>;
  send(message: Record<string, unknown>): Promise<KeePassWireResponse>;
  disconnect(): void;
}

export const NATIVE_APP_ID = 'org.keepassxc.keepassxc_browser';
export const KEEPASS_ERROR_NO_MATCH = 15;
