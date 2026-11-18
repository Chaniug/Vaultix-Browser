/** Content script 入口：只做字段识别与填充，不接触后端适配器（E-2 / S-4）。 */
import { collectSaveCandidate, detectFields, observeFields } from './detector.js';
import { fillFields } from './filler.js';
import { MSG, isRuntimeMessage } from '../shared/messages.js';

let notifyTimer: ReturnType<typeof setTimeout> | null = null;

observeFields(document, () => {
  if (notifyTimer !== null) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    const fields = detectFields(document).map((field) => field.kind);
    void chrome.runtime.sendMessage({
      type: MSG.FIELDS_CHANGED,
      fields,
    });
  }, 150);
});

// 表单提交后采集保存候选，交给 background 提示用户确认（DEC-010）
document.addEventListener(
  'submit',
  (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    const candidate = collectSaveCandidate(event.target);
    if (!candidate) return;
    void chrome.runtime.sendMessage({
      type: MSG.SAVE_CANDIDATE,
      draft: candidate,
    });
  },
  true,
);

chrome.runtime.onMessage.addListener((message) => {
  if (!isRuntimeMessage(message)) return;
  if (message.type !== MSG.FILL) return;
  // 消息来自扩展自身（隔离世界），凭证只写入 input.value，不污染页面上下文
  fillFields(detectFields(document), message.plan);
});
