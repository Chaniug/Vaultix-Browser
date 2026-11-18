export { BitwardenAdapter } from './adapter.js';
export { BitwardenClient, resolveEndpoints } from './client-api.js';
export type { BitwardenSessionSnapshot } from './adapter.js';
export type { BitwardenConfig, BitwardenMode } from './types.js';

import { BitwardenAdapter } from './adapter.js';
import type { BitwardenConfig } from './types.js';

/** E-4：对外只暴露工厂 + 接口实现 */
export function createBitwardenAdapter(config: BitwardenConfig): BitwardenAdapter {
  return new BitwardenAdapter(config);
}
