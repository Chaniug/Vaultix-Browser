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

test('只有 type="email" 的输入框也识别为账号框', () => {
  const form = document.getElementById('login');
  form.replaceChildren();
  const email = document.createElement('input');
  email.type = 'email';
  const pass = document.createElement('input');
  pass.type = 'password';
  form.append(email, pass);
  const fields = detectFields(document);
  assert.deepEqual(
    fields.map((field) => field.kind),
    ['username', 'password'],
  );
  assert.equal(fields[0].element, email);
});

test('账号框没有任何提示性命名时：紧挨首个密码框之前的文本框视为账号框', () => {
  const form = document.getElementById('login');
  form.replaceChildren();
  const account = document.createElement('input');
  account.type = 'text';
  const pass = document.createElement('input');
  pass.type = 'password';
  const confirm = document.createElement('input');
  confirm.type = 'password';
  form.append(account, pass, confirm);
  const fields = detectFields(document);
  // 确认密码框不会被再次当作待填字段
  assert.deepEqual(
    fields.map((field) => field.kind),
    ['username', 'password'],
  );
  assert.equal(fields[0].element, account);
  assert.equal(fields[1].element, pass);
});

test('pairUsernameFor：同表单内优先，否则取文档顺序上最近的前一个账号框', async () => {
  const { pairUsernameFor } = await import('../.test-build/src/content/detector.js');
  const form = document.getElementById('login');
  const first = form.querySelector('#username');
  const password = form.querySelector('#password');
  assert.equal(pairUsernameFor(password), first);

  // 两个都不在表单里：密码框取它前面最近的那个账号框
  const orphanUser = document.createElement('input');
  orphanUser.name = 'login';
  orphanUser.type = 'text';
  const orphanPass = document.createElement('input');
  orphanPass.type = 'password';
  document.body.append(orphanUser, orphanPass);
  assert.equal(pairUsernameFor(orphanPass), orphanUser);
});

test('只有与输入框有关的 DOM 变动才算相关（把频繁重渲染的噪声挡在重新扫描之外）', async () => {
  const { isFieldRelevantMutation } = await import('../.test-build/src/content/detector.js');
  // 浏览器里 Element 本来就是全局；jsdom 需要显式挂上
  globalThis.Element = dom.window.Element;
  const records = await new Promise((resolve) => {
    const observer = new MutationObserver((mutations) => {
      observer.disconnect();
      resolve(mutations);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    });
    // 无关：普通文本节点
    const span = document.createElement('span');
    span.textContent = 'loading…';
    document.body.append(span);
    // 相关：子树里带输入框
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<input type="password" />';
    document.body.append(wrapper);
    // 相关：含有输入框的元素改了样式（登录弹窗显示 / 隐藏）
    document.getElementById('login').style.display = 'block';
    // 无关：不含输入框的元素
    const plain = document.createElement('div');
    document.body.append(plain);
    plain.style.display = 'none';
  });
  assert.deepEqual(records.map(isFieldRelevantMutation), [false, true, true, false, false]);
});
