/** Offscreen document：在 MV3 中代理剪贴板写入，并保证超时清空（S-5）。 */
import { isRuntimeMessage, MSG } from '../shared/messages.js';

let clearTimer: ReturnType<typeof setTimeout> | null = null;

chrome.runtime.onMessage.addListener((message) => {
  if (!isRuntimeMessage(message) || message.type !== MSG.COPY) return;
  void navigator.clipboard.writeText(message.text);
  if (clearTimer !== null) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    void navigator.clipboard.writeText('');
  }, message.ttlMs ?? 30_000);
});
