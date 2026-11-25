/**
 * 页面内浮层：纯逻辑（过滤 / 键盘 / 定位 / 自动填充判定）+ jsdom 下的行为验证。
 * jsdom 没有真实布局，可见性与坐标统一用一个固定的 getBoundingClientRect 桩。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountOverlay } from '../.test-build/src/content/overlay.js';
import {
  filterSuggestions,
  placeBar,
  placeIcon,
  placePanel,
  pickTotpSource,
  shouldAutoFill,
  stepSelection,
} from '../.test-build/src/content/overlay-model.js';
import { isFieldVisible } from '../.test-build/src/content/detector.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const KP = {
  id: 'kp-1',
  source: 'keepassxc',
  name: 'Work Mail',
  username: 'alice@example.com',
  hasTotp: true,
};
const BW = {
  id: 'bw-1',
  source: 'bitwarden',
  name: 'Personal',
  username: 'valkjin@outlook.com',
  hasTotp: false,
};

// ---------- 纯逻辑 ----------

test('过滤：无输入返回全部；命中则过滤；没有命中时仍返回全部', () => {
  const items = [KP, BW];
  assert.deepEqual(filterSuggestions(items, ''), items);
  assert.deepEqual(filterSuggestions(items, '  '), items);
  assert.deepEqual(filterSuggestions(items, 'ALICE'), [KP]);
  assert.deepEqual(filterSuggestions(items, 'valkjin'), [BW]);
  assert.deepEqual(filterSuggestions(items, 'zzz-no-match'), items);
});

test('键盘步进：没有高亮时向下取第一个、向上取最后一个，并循环', () => {
  assert.equal(stepSelection(-1, 1, 3), 0);
  assert.equal(stepSelection(-1, -1, 3), 2);
  assert.equal(stepSelection(2, 1, 3), 0);
  assert.equal(stepSelection(0, -1, 3), 2);
  assert.equal(stepSelection(0, 1, 0), -1);
});

test('面板定位：空间够时在输入框下方，宽度随输入框并夹在范围内', () => {
  const below = placePanel(
    { top: 100, left: 50, width: 500, height: 32 },
    { width: 1280, height: 800 },
  );
  assert.equal(below.placement, 'below');
  assert.equal(below.top, 100 + 32 + 6);
  assert.equal(below.width, 380);

  const narrow = placePanel(
    { top: 100, left: 50, width: 120, height: 32 },
    { width: 1280, height: 800 },
  );
  assert.equal(narrow.width, 300);

  const farRight = placePanel(
    { top: 100, left: 1200, width: 300, height: 32 },
    { width: 1280, height: 800 },
  );
  assert.equal(farRight.left, 1280 - 300 - 8);
});

test('面板定位：下方空间不足时翻到输入框上方', () => {
  const field = { top: 760, left: 50, width: 300, height: 32 };
  const placed = placePanel(field, { width: 1280, height: 800 });
  assert.equal(placed.placement, 'above');
  assert.ok(placed.top < field.top);
});

test('输入框内图标贴右缘并垂直居中；提示条在顶部居中', () => {
  assert.deepEqual(placeIcon({ top: 100, left: 200, width: 300, height: 32 }), {
    left: 200 + 300 - 22 - 8,
    top: 100 + 5,
  });
  const bar = placeBar({ width: 1280, height: 800 });
  assert.equal(bar.width, 420);
  assert.equal(bar.left, (1280 - 420) / 2);
  assert.equal(placeBar({ width: 300, height: 800 }).width, 300 - 32);
});

test('自动填充：六个条件全部成立才填', () => {
  const ok = {
    enabled: true,
    matchCount: 1,
    usernameEmpty: true,
    passwordEmpty: true,
    secureContext: true,
    topFrame: true,
  };
  assert.equal(shouldAutoFill(ok), true);
  assert.equal(shouldAutoFill({ ...ok, enabled: false }), false);
  assert.equal(shouldAutoFill({ ...ok, matchCount: 2 }), false);
  assert.equal(shouldAutoFill({ ...ok, matchCount: 0 }), false);
  assert.equal(shouldAutoFill({ ...ok, usernameEmpty: false }), false);
  assert.equal(shouldAutoFill({ ...ok, passwordEmpty: false }), false);
  assert.equal(shouldAutoFill({ ...ok, secureContext: false }), false);
  assert.equal(shouldAutoFill({ ...ok, topFrame: false }), false);
});

test('验证码该填给谁：优先刚填充过的那条', () => {
  assert.equal(pickTotpSource([BW, KP], null), KP);
  assert.equal(pickTotpSource([KP], { source: 'keepassxc', id: 'kp-1' }), KP);
  assert.equal(pickTotpSource([BW], null), undefined);
});

// ---------- jsdom 行为 ----------

let dom;
let calls;
let suggestions;
let root;
let controller;

// 浮层打开期间有定时轮询，每个用例结束时必须销毁，否则测试进程不会退出
afterEach(() => {
  controller?.destroy();
  controller = null;
});

function mount(extra = {}) {
  controller = mountOverlay(
    document,
    {
      search: async () => suggestions,
      fill: async (item, fields, copyTotp) => {
        calls.fill.push({ item, fields, copyTotp });
        return { ok: true, plan: { username: 'alice', password: 'pw', totp: '123456' } };
      },
      copy: async (item, kind) => {
        calls.copy.push({ item, kind });
        return true;
      },
      applyPlan: (plan) => {
        calls.apply.push(plan);
        return 2;
      },
      saveCheck: async () => ({ action: 'create', sources: ['keepassxc', 'bitwarden'] }),
      saveConfirm: async (source) => {
        calls.confirm.push(source);
        return { ok: true, source };
      },
      saveDismiss: async () => {
        calls.dismiss += 1;
      },
      openPopup: async () => {},
      pageUrl: () => 'https://example.com/login',
      ...extra,
    },
    { shadowMode: 'open' },
  );
  root = document.documentElement.lastElementChild.shadowRoot;
  return controller;
}

function focusIn(target) {
  target.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
}
function focusOut(target) {
  target.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
}
function press(target, key) {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }));
}
const panel = () => root.querySelector('.vx-panel');
const rows = () => [...root.querySelectorAll('.vx-row')];
const visible = (element) => element !== null && !element.classList.contains('vx-hidden');

beforeEach(() => {
  dom = new JSDOM(
    `<!doctype html><html><body>
      <form id="login">
        <input id="username" name="username" type="text" />
        <input id="password" type="password" />
      </form>
    </body></html>`,
    { url: 'https://example.com/login', pretendToBeVisual: true },
  );
  for (const key of [
    'HTMLInputElement',
    'HTMLButtonElement',
    'HTMLElement',
    'Element',
    'Node',
    'Event',
    'FocusEvent',
    'KeyboardEvent',
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
  calls = { fill: [], copy: [], apply: [], confirm: [], dismiss: 0 };
  suggestions = { items: [KP, BW], ambiguous: true, autoFillOnLoad: false, anyReady: true };
});

test('账号与密码框可见时才识别为可见字段', () => {
  const username = document.getElementById('username');
  assert.equal(isFieldVisible(username), true);
  username.style.display = 'none';
  assert.equal(isFieldVisible(username), false);
});

test('候选加载后显示输入框图标；聚焦弹出候选，点击"填充"走统一填充服务', async () => {
  mount();
  await tick();

  const icon = root.querySelector('.vx-icon');
  assert.equal(visible(icon), true);
  assert.equal(icon.classList.contains('muted'), false);
  assert.equal(visible(panel()), false);

  const username = document.getElementById('username');
  focusIn(username);
  assert.equal(visible(panel()), true);
  assert.equal(rows().length, 2);
  assert.match(root.querySelector('.vx-panel-head').textContent, /2 条匹配凭证/);
  assert.match(rows()[0].textContent, /Work Mail/);

  rows()[0].querySelector('.vx-btn.primary').click();
  await tick();
  assert.equal(calls.fill.length, 1);
  assert.deepEqual(calls.fill[0].fields, ['username', 'password']);
  assert.equal(calls.fill[0].copyTotp, true);
  assert.deepEqual(calls.apply, [{ username: 'alice', password: 'pw', totp: '123456' }]);
  // 填充后收起，并且同一输入框失焦前不再自动弹出
  assert.equal(visible(panel()), false);
  focusIn(username);
  assert.equal(visible(panel()), false);
  focusOut(username);
  focusIn(username);
  assert.equal(visible(panel()), true);
});

test('方向键 + 回车填充；Esc 收起', async () => {
  mount();
  await tick();
  const username = document.getElementById('username');
  focusIn(username);
  press(username, 'ArrowDown');
  assert.equal(rows()[0].classList.contains('active'), true);
  press(username, 'ArrowDown');
  assert.equal(rows()[1].classList.contains('active'), true);
  press(username, 'Enter');
  await tick();
  assert.equal(calls.fill.length, 1);
  assert.equal(calls.fill[0].item.id, 'bw-1');

  focusOut(username);
  focusIn(username);
  assert.equal(visible(panel()), true);
  press(username, 'Escape');
  assert.equal(visible(panel()), false);
});

test('输入时按名称 / 用户名过滤候选', async () => {
  mount();
  await tick();
  const username = document.getElementById('username');
  focusIn(username);
  username.value = 'valkjin';
  username.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(rows().length, 1);
  assert.match(rows()[0].textContent, /Personal/);
});

test('页面有验证码框时：填充顺带验证码，并显示验证码图标可单独刷新', async () => {
  const otp = document.createElement('input');
  otp.name = 'otp';
  otp.type = 'text';
  document.getElementById('login').append(otp);
  mount();
  await tick();

  const username = document.getElementById('username');
  focusIn(username);
  rows()[0].querySelector('.vx-btn.primary').click();
  await tick();
  assert.deepEqual(calls.fill[0].fields, ['username', 'password', 'totp']);

  const totpIcon = root.querySelector('.vx-icon.totp');
  assert.equal(visible(totpIcon), true);
  focusOut(username);
  totpIcon.click();
  await tick();
  assert.equal(calls.fill.length, 2);
  // 验证码图标优先作用于刚填充过的那条
  assert.equal(calls.fill[1].item.id, 'kp-1');
  assert.deepEqual(calls.fill[1].fields, ['totp']);
});

test('复制密码只报条目，不经过填充', async () => {
  mount();
  await tick();
  const username = document.getElementById('username');
  focusIn(username);
  const copyButtons = rows()[0].querySelectorAll('.vx-btn.compact');
  [...copyButtons].at(-1).click();
  await tick();
  assert.deepEqual(calls.copy, [{ item: KP, kind: 'password' }]);
  assert.equal(calls.fill.length, 0);
});

test('凭证库未连接：图标变灰，聚焦给出连接引导而不是"无匹配"', async () => {
  suggestions = { items: [], ambiguous: false, autoFillOnLoad: false, anyReady: false };
  mount();
  await tick();
  assert.equal(root.querySelector('.vx-icon').classList.contains('muted'), true);
  focusIn(document.getElementById('username'));
  assert.match(panel().textContent, /凭证库尚未连接/);
  assert.equal(rows().length, 0);
});

test('唯一匹配 + 空表单 + 已开启时自动填充；多匹配时不自动填', async () => {
  suggestions = { items: [KP], ambiguous: false, autoFillOnLoad: true, anyReady: true };
  mount();
  await tick();
  await tick();
  assert.equal(calls.fill.length, 1);
  assert.equal(calls.fill[0].copyTotp, false);
  assert.deepEqual(calls.fill[0].fields, ['username', 'password']);
});

test('两条匹配时不自动填充，只提供候选', async () => {
  suggestions = { items: [KP, BW], ambiguous: true, autoFillOnLoad: true, anyReady: true };
  mount();
  await tick();
  await tick();
  assert.equal(calls.fill.length, 0);
  assert.equal(visible(root.querySelector('.vx-icon')), true);
});

test('本页提交后 offerSave：先向后台判定，再显示提示条', async () => {
  const overlay = mount();
  await tick();
  overlay.offerSave({ url: 'https://example.com/login', username: 'alice', password: 'new-pass' });
  await tick();
  await tick();
  const bar = root.querySelector('.vx-bar:not(.vx-toast)');
  assert.equal(visible(bar), true);
  assert.match(bar.textContent, /保存到 KeePassXC\？alice/);
  // 两个库都可写时允许切换保存目标
  assert.equal(bar.querySelectorAll('.vx-src button').length, 2);
});

test('恢复暂存的保存草稿：显示提示条，确认与忽略都只报来源', async () => {
  const overlay = mount();
  await tick();
  overlay.restoreSave({
    username: 'alice@example.com',
    decision: { action: 'create', sources: ['keepassxc'] },
  });
  const bar = root.querySelector('.vx-bar:not(.vx-toast)');
  assert.equal(visible(bar), true);
  assert.match(bar.textContent, /保存到 KeePassXC\？alice@example\.com/);

  bar.querySelector('.vx-btn.primary').click();
  await tick();
  assert.deepEqual(calls.confirm, ['keepassxc']);
  assert.equal(visible(root.querySelector('.vx-bar:not(.vx-toast)')), false);

  overlay.restoreSave({
    username: 'bob',
    decision: {
      action: 'update',
      target: { source: 'bitwarden', id: 'bw-9', name: 'Bob', username: 'bob' },
      sources: ['bitwarden'],
    },
  });
  const updateBar = root.querySelector('.vx-bar:not(.vx-toast)');
  assert.match(updateBar.textContent, /密码已更改，更新「Bob」/);
  [...updateBar.querySelectorAll('.vx-btn')].at(-1).click();
  await tick();
  assert.equal(calls.dismiss, 1);
  // 忽略后同一份草稿不再重复提示
  overlay.restoreSave({
    username: 'bob',
    decision: {
      action: 'update',
      target: { source: 'bitwarden', id: 'bw-9', name: 'Bob', username: 'bob' },
      sources: ['bitwarden'],
    },
  });
  assert.equal(visible(root.querySelector('.vx-bar:not(.vx-toast)')), false);
});

test('浮层挂在 Shadow DOM 里，候选文字不出现在页面可读的 DOM 中', async () => {
  mount();
  await tick();
  const host = document.documentElement.lastElementChild;
  assert.notEqual(host.shadowRoot, null);
  assert.equal(host.textContent, '');
  assert.equal(document.body.textContent.includes('alice@example.com'), false);
});
