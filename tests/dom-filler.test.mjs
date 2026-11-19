/** T-3 / T-7：表单识别与填充集成测试（普通表单、Shadow DOM、动态表单）。 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { detectFields, observeFields } from '../.test-build/src/content/detector.js';
import { fillFields } from '../.test-build/src/content/filler.js';

let dom;

beforeEach(() => {
  dom = new JSDOM(
    `<!doctype html><html><body>
      <form id="login">
        <input name="username" id="username" type="text" />
        <input name="pass" id="password" type="password" />
        <input name="otp" id="otp" type="text" autocomplete="one-time-code" />
      </form>
      <div id="host"></div>
    </body></html>`,
    { url: 'https://example.com/login' },
  );
  globalThis.document = dom.window.document;
  globalThis.HTMLInputElement = dom.window.HTMLInputElement;
  globalThis.NodeFilter = dom.window.NodeFilter;
  globalThis.Event = dom.window.Event;
  globalThis.location = dom.window.location;
  globalThis.MutationObserver = dom.window.MutationObserver;
});

test('普通表单识别三类字段', () => {
  const kinds = detectFields(document).map((field) => field.kind);
  assert.deepEqual(kinds, ['username', 'password', 'totp']);
});

test('Shadow DOM 中的字段也能识别', () => {
  const host = document.getElementById('host');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<input name="email" type="email" /><input type="password" />';
  const kinds = detectFields(document).map((field) => field.kind);
  assert.deepEqual(kinds, ['username', 'password', 'totp']);
  // 第一个 username 在普通表单中已被占用，Shadow DOM 的 password 不应覆盖
  assert.equal(detectFields(shadow).map((field) => field.kind)[0], 'username');
});

test('动态插入的表单字段可检测（SPA 场景）', async () => {
  const form = document.getElementById('login');
  form.replaceChildren();
  assert.equal(detectFields(document).length, 0);

  let changes = 0;
  const observer = observeFields(document, () => {
    changes += 1;
  });
  const input = document.createElement('input');
  input.name = 'login';
  form.append(input);
  await new Promise((resolve) => setTimeout(resolve, 0));
  observer.disconnect();

  assert.ok(changes > 0);
  assert.deepEqual(
    detectFields(document).map((field) => field.kind),
    ['username'],
  );
});

test('填充只写 value 与派发事件，不写入页面可读属性', () => {
  const fields = detectFields(document);
  let inputEvents = 0;
  let changeEvents = 0;
  for (const field of fields) {
    field.element.addEventListener('input', () => {
      inputEvents += 1;
    });
    field.element.addEventListener('change', () => {
      changeEvents += 1;
    });
  }
  const count = fillFields(fields, {
    username: 'alice',
    password: 's3cret',
    totp: '654321',
  });
  assert.equal(count, 3);
  assert.equal(document.getElementById('username').value, 'alice');
  assert.equal(document.getElementById('password').value, 's3cret');
  assert.equal(document.getElementById('otp').value, '654321');
  assert.equal(inputEvents, 3);
  assert.equal(changeEvents, 3);
  for (const field of fields) {
    assert.equal(field.element.hasAttribute('data-password'), false);
    assert.equal(field.element.hasAttribute('value'), false);
  }
});

test('表单提交时采集保存候选（不写入页面）', async () => {
  const { collectSaveCandidate } = await import('../.test-build/src/content/detector.js');
  const form = document.getElementById('login');
  form.querySelector('#username').value = 'alice';
  form.querySelector('#password').value = 'new-pass';
  const candidate = collectSaveCandidate(form);
  assert.equal(candidate.username, 'alice');
  assert.equal(candidate.password, 'new-pass');
  assert.equal(typeof candidate.url, 'string');

  form.querySelector('#password').value = '';
  assert.equal(collectSaveCandidate(form), null);
});
