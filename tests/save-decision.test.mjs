/**
 * 保存判定（纯逻辑）+ 保存检测（jsdom）。
 * 保存检测用真实计时：提交后 1 秒检查表单是否消失，用例里会真的等这段时间。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { coerceDraft, decideSaveAction } from '../.test-build/src/core/save.js';
import { startSaveWatcher } from '../.test-build/src/content/save-watcher.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => sleep(0);
const URL_ = 'https://example.com/login';

const entry = (source, id, username, password) => ({
  id,
  source,
  name: `Entry ${id}`,
  username,
  password,
});

// ---------- 判定 ----------

test('没有可写来源 → none', () => {
  assert.deepEqual(
    decideSaveAction(
      [entry('bitwarden', 'a', 'alice', 'x')],
      { url: URL_, username: 'alice', password: 'x' },
      [],
    ),
    {
      action: 'none',
      sources: [],
    },
  );
});

test('同用户名同密码已存在 → none（正常登录不打扰）', () => {
  const items = [entry('keepassxc', 'kp-1', 'alice', 'same')];
  const decision = decideSaveAction(items, { url: URL_, username: 'alice', password: 'same' }, [
    'keepassxc',
  ]);
  assert.equal(decision.action, 'none');
});

test('同用户名但密码不同 → update，且只能写回该条目所在的库', () => {
  const items = [entry('keepassxc', 'kp-1', 'alice', 'old')];
  const decision = decideSaveAction(items, { url: URL_, username: 'alice', password: 'new' }, [
    'bitwarden',
    'keepassxc',
  ]);
  assert.equal(decision.action, 'update');
  assert.deepEqual(decision.target, {
    source: 'keepassxc',
    id: 'kp-1',
    name: 'Entry kp-1',
    username: 'alice',
  });
  assert.deepEqual(decision.sources, ['keepassxc']);
});

test('新用户名 → create，可写来源原样返回', () => {
  const decision = decideSaveAction(
    [entry('keepassxc', 'kp-1', 'bob', 'x')],
    { url: URL_, username: 'alice', password: 'pw' },
    ['bitwarden', 'keepassxc'],
  );
  assert.deepEqual(decision, { action: 'create', sources: ['bitwarden', 'keepassxc'] });
});

test('多条同用户名：优先更新排在前面（默认库）的那条', () => {
  const items = [
    entry('bitwarden', 'bw-1', 'alice', 'old'),
    entry('keepassxc', 'kp-1', 'alice', 'old'),
  ];
  const decision = decideSaveAction(items, { url: URL_, username: 'alice', password: 'new' }, [
    'keepassxc',
    'bitwarden',
  ]);
  assert.equal(decision.target.source, 'bitwarden');
});

test('要更新的条目所在库当前不可写 → none（不在另一个库里建重复条目）', () => {
  const items = [entry('keepassxc', 'kp-1', 'alice', 'old')];
  const decision = decideSaveAction(items, { url: URL_, username: 'alice', password: 'new' }, [
    'bitwarden',
  ]);
  assert.equal(decision.action, 'none');
});

test('用户名比较忽略大小写与首尾空白；空用户名的条目不参与匹配', () => {
  const items = [
    entry('keepassxc', 'kp-1', ' Alice ', 'pw'),
    entry('keepassxc', 'kp-2', '', 'other'),
  ];
  const decision = decideSaveAction(items, { url: URL_, username: 'alice', password: 'pw' }, [
    'keepassxc',
  ]);
  assert.equal(decision.action, 'none');
});

test('coerceDraft：拒绝缺字段、非字符串、非 http(s) 地址，丢弃未知字段', () => {
  const good = coerceDraft({
    url: URL_,
    username: 'alice',
    password: 'pw',
    name: 'Work',
    uuid: 'kp-1',
    source: 'keepassxc',
    meta: { evil: true },
  });
  assert.deepEqual(good, {
    url: URL_,
    username: 'alice',
    password: 'pw',
    name: 'Work',
    uuid: 'kp-1',
  });

  assert.equal(coerceDraft(null), null);
  assert.equal(coerceDraft({ url: URL_, username: 'alice' }), null);
  assert.equal(coerceDraft({ url: URL_, username: 'alice', password: '' }), null);
  assert.equal(coerceDraft({ url: URL_, username: 42, password: 'pw' }), null);
  assert.equal(coerceDraft({ url: 'javascript:alert(1)', username: 'a', password: 'pw' }), null);
  assert.equal(coerceDraft({ url: 'file:///etc/passwd', username: 'a', password: 'pw' }), null);
});

// ---------- 保存检测 ----------

let dom;
let watcher;
let stage;
let offer;

beforeEach(() => {
  dom = new JSDOM(
    `<!doctype html><html><body>
      <form id="login">
        <input id="username" name="username" type="text" />
        <input id="password" type="password" />
        <button id="go" type="button">登录</button>
      </form>
    </body></html>`,
    { url: URL_ },
  );
  for (const key of [
    'HTMLInputElement',
    'HTMLButtonElement',
    'HTMLFormElement',
    'HTMLElement',
    'Element',
    'Node',
    'Event',
    'NodeFilter',
    'MutationObserver',
  ]) {
    globalThis[key] = dom.window[key];
  }
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    top: 100,
    left: 100,
    right: 360,
    bottom: 132,
    width: 260,
    height: 32,
    x: 100,
    y: 100,
  });

  stage = [];
  offer = [];
  watcher = startSaveWatcher(document, {
    stage: async (draft) => {
      stage.push(draft);
      return { action: 'create', sources: ['keepassxc'] };
    },
    offer: (draft, decision) => {
      offer.push({ draft, decision });
    },
    pageUrl: () => URL_,
  });
});

function typeInto(id, value) {
  const input = document.getElementById(id);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function submit() {
  document
    .getElementById('login')
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

test('表单 submit：先把草稿交给后台暂存；表单消失（登录成功）后才弹出提示', async () => {
  typeInto('username', 'alice');
  typeInto('password', 'new-pass');
  submit();
  await tick();
  assert.deepEqual(stage, [{ url: URL_, username: 'alice', password: 'new-pass' }]);
  assert.equal(offer.length, 0);

  document.getElementById('login').remove();
  await sleep(1100);
  assert.equal(offer.length, 1);
  assert.equal(offer[0].decision.action, 'create');
  assert.equal(offer[0].draft.password, 'new-pass');
  watcher.dispose();
});

test('我们自己填充的密码，用户没改过 → 不询问是否保存', async () => {
  const password = document.getElementById('password');
  watcher.noteProgrammaticFill(password, 'filled-by-us');
  password.value = 'filled-by-us';
  // fillFields 写值时会派发 input 事件
  password.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('username').value = 'alice';
  submit();
  await tick();
  assert.equal(stage.length, 0);
  watcher.dispose();
});

test('用户输入之后被站点脚本替换成哈希的值不采用，仍以用户输入的为准', async () => {
  typeInto('username', 'alice');
  typeInto('password', 'my-password');
  // 站点在提交前把密码框换成哈希（不经过输入事件）
  document.getElementById('password').value = 'a'.repeat(64);
  submit();
  await tick();
  assert.equal(stage.length, 1);
  assert.equal(stage[0].password, 'my-password');
  watcher.dispose();
});

test('SPA：点击按钮不触发 submit，表单消失后才弹出提示', async () => {
  typeInto('username', 'alice');
  typeInto('password', 'new-pass');
  document
    .getElementById('go')
    .dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));

  // 点了按钮但表单还在（例如校验没过）：不提示
  await sleep(600);
  assert.equal(offer.length, 0);

  document.getElementById('login').remove();
  await sleep(600);
  assert.equal(offer.length, 1);
  assert.equal(offer[0].decision, null);
  watcher.dispose();
});

test('登录失败（表单原样保留）→ 不提示', async () => {
  typeInto('username', 'alice');
  typeInto('password', 'new-pass');
  document.getElementById('go').dispatchEvent(new Event('click', { bubbles: true }));
  await sleep(2700);
  assert.equal(offer.length, 0);
  watcher.dispose();
});
