/**
 * 页面主世界入口。
 * 该上下文没有 chrome.* 扩展 API，只能操作 DOM 与 WebAuthn，
 * 与扩展的通信全部经过隔离世界的中继（passkeys-relay.ts）。
 */
import { installPasskeyProvider } from './passkey-provider.js';

installPasskeyProvider();
