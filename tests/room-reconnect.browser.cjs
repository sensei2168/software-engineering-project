// 在 Chrome 的真实 DOM 中运行原始交互草图；虚拟时钟仅由测试注入。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');
const browser = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const source = fs.readFileSync(path.join(__dirname, '../docs/比赛房间草图/比赛房间-交互草图.html'), 'utf8');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'room-reconnect-'));

function clock() {
  const NativeDate = Date;
  let now = 1800000000000, serial = 0;
  const callbacks = new Map();
  window.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  window.setInterval = callback => { callbacks.set(++serial, callback); return serial; };
  window.clearInterval = id => callbacks.delete(id);
  window.roomTestClock = { advance(ms) {
    now += ms;
    for (const [id, callback] of [...callbacks]) if (callbacks.has(id)) callback();
  } };
}

const cases = [
  ['准备中重连保留两名成员和各自准备状态', ui => {
    ui.nav('ready'); ui.action('toggle-ready');
    ui.demo('offline'); ui.action('retry');
    ui.twoMembers(); ui.prepared(true, false); ui.disabled('start');
    ui.demo('offline'); ui.demo('offline'); ui.action('retry');
    ui.twoMembers(); ui.prepared(true, false);
  }],
  ['倒计时重连沿用原 startAt，不重新倒数三秒', ui => {
    ui.nav('both'); ui.action('start'); ui.advance(1000);
    ui.demo('offline'); ui.action('retry');
    ui.twoMembers(); ui.count(2);
    ui.advance(2000); ui.contains('下一步：比赛答题页'); ui.twoMembers();
  }],
  ['断线期间已开赛，重连直接展示答题页接入位置', ui => {
    ui.nav('both'); ui.action('start'); ui.demo('offline'); ui.advance(4000);
    ui.action('retry'); ui.contains('下一步：比赛答题页'); ui.twoMembers();
    ui.message('已开赛');
  }],
  ['断线期间已结束，重连展示结束接入位置', ui => {
    ui.nav('both'); ui.action('start'); ui.demo('offline'); ui.advance(124000);
    ui.action('retry'); ui.contains('本场比赛已结束'); ui.twoMembers();
    ui.message('已结束');
  }],
  ['明确模拟取消开始后，重连保留两人并清除准备', ui => {
    ui.nav('both'); ui.action('start'); ui.demo('offline'); ui.demo('cancel-start');
    ui.message('模拟服务端事件'); ui.action('retry');
    ui.twoMembers(); ui.prepared(false, false); ui.disabled('start'); ui.message('取消开始');
    ui.advance(5000); ui.prepared(false, false); ui.disabled('start');
  }],
  ['明确模拟伙伴准备变化后，重连说明变化来源', ui => {
    ui.nav('ready'); ui.action('toggle-ready'); ui.demo('offline');
    ui.demo('partner-ready'); ui.message('模拟服务端事件'); ui.action('retry');
    ui.twoMembers(); ui.prepared(true, true); ui.enabled('start'); ui.message('伙伴');
  }],
  ['明确模拟关闭房间后，旧倒计时不能复活本局', ui => {
    ui.nav('both'); ui.action('start'); ui.demo('offline'); ui.demo('close-room');
    ui.action('retry'); ui.contains('房间已取消'); ui.twoMembers(); ui.message('关闭');
    ui.advance(10000); ui.contains('房间已取消');
  }],
  ['重复断线及重试保持同一倒计时和成员', ui => {
    ui.nav('both'); ui.action('start'); ui.demo('offline'); ui.demo('offline');
    ui.advance(1000); ui.action('retry'); ui.count(2); ui.twoMembers();
    ui.demo('offline'); ui.advance(1000); ui.action('retry'); ui.count(1); ui.twoMembers();
  }],
  ['原本一人等待的房间重连仍为一人', ui => {
    ui.nav('waiting'); ui.demo('offline'); ui.action('retry');
    ui.contains('1 / 2 人'); ui.contains('等待另一位伙伴');
  }],
  ['加入者恢复后不能自行开始，只能接收房主开始事件', ui => {
    ui.nav('both'); ui.demo('role'); ui.demo('offline'); ui.action('retry');
    ui.twoMembers(); ui.disabled('noop');
    ui.demo('host-start'); ui.advance(1000); ui.demo('offline'); ui.action('retry');
    ui.twoMembers(); ui.count(2);
  }],
  ['取消后重新准备与开始使用新倒计时，旧回调不生效', ui => {
    ui.nav('both'); ui.action('start'); ui.advance(1000); ui.action('cancel-start');
    ui.twoMembers(); ui.prepared(false, false); ui.advance(3000);
    ui.action('toggle-ready'); ui.demo('partner-ready'); ui.action('start'); ui.count(3);
    ui.advance(1000); ui.count(2); ui.advance(2000); ui.contains('下一步：比赛答题页');
  }],
  ['无原房间的加入失败，重试明确模拟接受加入', ui => {
    ui.nav('join'); ui.input('333333'); ui.action('submit-join'); ui.action('retry');
    ui.twoMembers(); ui.prepared(false, false); ui.message('接受加入');
  }],
  ['从创建到双方准备不会自动开始，仍须房主点击开始', ui => {
    ui.action('create'); ui.contains('1 / 2 人'); ui.demo('partner-join');
    ui.action('toggle-ready'); ui.demo('partner-ready'); ui.advance(5000);
    ui.twoMembers(); ui.prepared(true, true); ui.enabled('start');
    ui.action('start'); ui.count(3);
  }],
  ['切换加入者身份后重连保留同一成员的准备状态', ui => {
    ui.nav('ready'); ui.demo('role'); ui.action('toggle-ready');
    ui.demo('offline'); ui.action('retry'); ui.prepared(true, false); ui.disabled('noop');
    ui.demo('role'); ui.prepared(false, true); ui.disabled('start');
  }],
  ['断线期间伙伴加入须有明确事件，重连显示两人', ui => {
    ui.nav('waiting'); ui.demo('offline'); ui.demo('partner-join');
    ui.message('模拟服务端事件'); ui.action('retry'); ui.twoMembers(); ui.prepared(false, false);
  }],
  ['开赛边界后拒绝取消或关闭，仍显示已开赛', ui => {
    ui.nav('both'); ui.action('start'); ui.advance(3000);
    ui.demo('cancel-start'); ui.message('拒绝取消'); ui.contains('下一步：比赛答题页');
    ui.demo('close-room'); ui.message('拒绝关闭'); ui.twoMembers();
  }],
  ['没有房间时模拟断线不会凭空创建单人房间', ui => {
    ui.demo('offline'); ui.contains('创建一场小比赛'); ui.message('请先创建或加入房间');
  }],
  ['直接查看倒计时示例也会按时间进入答题接入位置', ui => {
    ui.nav('countdown'); ui.count(3); ui.advance(3000);
    ui.contains('下一步：比赛答题页'); ui.twoMembers();
  }]
];

async function run(source, clockSource, definitions) {
  if (!document.body) await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  const results = [];
  for (const [name, definition] of definitions) {
    const frame = document.createElement('iframe');
    const loaded = new Promise(resolve => frame.onload = resolve);
    frame.srcdoc = source.replace('<script>', '<script>(' + clockSource + ')();</script><script>');
    document.body.append(frame); await loaded;
    const win = frame.contentWindow, doc = win.document;
    function check(condition, message) { if (!condition) throw new Error(message); }
    function tap(selector) {
      const element = doc.querySelector(selector);
      check(element && !element.disabled, '按钮不可用：' + selector); element.click();
    }
    const ui = {
      nav: value => tap('[data-state="' + value + '"]'),
      action: value => tap('#phone [data-action="' + value + '"]'),
      demo: value => tap('[data-demo="' + value + '"]'),
      advance: ms => win.roomTestClock.advance(ms),
      contains: text => check(doc.querySelector('#phone').textContent.includes(text), '手机区域缺少：' + text),
      message: text => check(doc.querySelector('#demo-message').textContent.includes(text), '提示缺少：' + text),
      twoMembers() { this.contains('2 / 2 人'); check(!doc.querySelector('#phone .member-empty'), '伙伴变成空位'); },
      prepared(own, partner) {
        const flags = [...doc.querySelectorAll('#phone .member-state')].map(el => el.classList.contains('done'));
        check(flags.length === 2 && flags[0] === own && flags[1] === partner, '准备状态不符：' + JSON.stringify(flags));
      },
      disabled: action => check(doc.querySelector('#phone [data-action="' + action + '"]')?.disabled, action + ' 应禁用'),
      enabled: action => check(doc.querySelector('#phone [data-action="' + action + '"]')?.disabled === false, action + ' 应可用'),
      count: value => check(doc.querySelector('#phone .count-circle')?.textContent === String(value), '倒计时不符，预期 ' + value),
      input(value) { const input = doc.querySelector('#phone input'); input.value = value; input.dispatchEvent(new win.Event('input')); }
    };
    try { (0, eval)('(' + definition + ')')(ui); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
    frame.remove();
  }
  const result = document.createElement('pre'); result.id = 'room-result';
  result.textContent = JSON.stringify(results); document.body.append(result);
}

const page = path.join(output, 'room-tests.html');
const runner = '(' + run.toString() + ')(' + JSON.stringify(source) + ',' + JSON.stringify(clock.toString()) + ',' +
  JSON.stringify(cases.map(([name, test]) => [name, test.toString()])) + ');';
fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><script>' + runner.replace(/<\/script/gi, '<\\/script') + '</script>');
const result = cp.spawnSync(browser, ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--user-data-dir=' + path.join(output, 'profile'), '--virtual-time-budget=10000', '--dump-dom', pathToFileURL(page).href],
{ encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
const match = (result.stdout || '').match(/<pre id="room-result">([\s\S]*?)<\/pre>/);
if (!match) {
  fs.writeFileSync(path.join(output, 'failed-dom.html'), result.stdout || '');
  throw new Error(result.error?.message || 'Missing room test result; inspect ' + output);
}
const results = JSON.parse(match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
console.log(JSON.stringify({ cases: results.length, passed: results.filter(x => x.passed).length, results }, null, 2));
if (results.some(x => !x.passed)) process.exitCode = 1;
