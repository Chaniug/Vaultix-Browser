export { KeePassRpcAdapter } from './adapter.js';
export { ChromeNativeTransport } from './transport.js';
export type { KeePassAssociation, KeePassRpcConfig, NativeTransport } from './types.js';

import { KeePassRpcAdapter } from './adapter.js';
import { ChromeNativeTransport } from './transport.js';
import type { KeePassRpcConfig, NativeTransport } from './types.js';

/** E-4：适配器目录对外只暴露工厂 + 接口实现 */
export function createKeePassRpcAdapter(
  config: KeePassRpcConfig = {},
  transport?: NativeTransport,
): KeePassRpcAdapter {
  return new KeePassRpcAdapter(transport ?? new ChromeNativeTransport(config.timeoutMs), config);
}
