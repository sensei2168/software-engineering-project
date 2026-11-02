// 从原生房间页WXML/WXSS和实际页面数据生成浏览器近似布局；不是微信真机截图。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { roomPageFixture } = require('./helpers/room-page-fixture.cjs');
const browser = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const output = process.env.ROOM_PREVIEW_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'native-room-layout-'));
fs.mkdirSync(output, { recursive: true });
const root = path.resolve(__dirname, '../miniapp');
const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const evaluate = (value, data) => vm.runInNewContext(value, data, { timeout: 1000 });
const interpolate = (value, data) => value.replace(/{{([\s\S]*?)}}/g, (_, expr) => escape(evaluate(expr, data)));
function parse(source) {
  const tree = { children: [] }, stack = [tree];
  for (const token of source.match(/<[^>]*>|[^<]+/g) || []) {
    if (token.startsWith('</')) { stack.pop(); continue; }
    if (!token.startsWith('<')) { stack.at(-1).children.push({ text: token }); continue; }
    const tag = /^<([\w-]+)/.exec(token)[1], attrs = {};
    for (const match of token.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[match[1]] = match[2];
    if (/\bwx:else(?:\s|>)/.test(token)) attrs['wx:else'] = true;
    const node = { tag, attrs, children: [] }; stack.at(-1).children.push(node);
    if (!token.endsWith('/>')) stack.push(node);
  }
  return tree.children;
}
function render(nodes, data) {
  let chain = false, matched = false;
  return nodes.map(node => {
    if (node.text !== undefined) return interpolate(node.text, data);
    const attrs = node.attrs;
    if (attrs['wx:if']) { chain = true; matched = !!evaluate(attrs['wx:if'].slice(2, -2), data); if (!matched) return ''; }
    else if (attrs['wx:elif']) {
      if (!chain || matched) return '';
      matched = !!evaluate(attrs['wx:elif'].slice(2, -2), data); if (!matched) return '';
    } else if (attrs['wx:else']) { if (!chain || matched) return ''; matched = true; }
    else chain = false;
    if (attrs['wx:for']) return evaluate(attrs['wx:for'].slice(2, -2), data).map((item, index) => {
      const clone = { ...node, attrs: { ...attrs } }; delete clone.attrs['wx:for'];
      return render([clone], { ...data, item, index });
    }).join('');
    if (node.tag === 'block') return render(node.children, data);
    const tag = ({ view: 'div', text: 'span', picker: 'div' })[node.tag] || node.tag;
    let htmlAttrs = Object.entries(attrs).filter(([key]) => ['class', 'value', 'placeholder', 'maxlength', 'aria-label'].includes(key))
      .map(([key, value]) => ' ' + key + '="' + interpolate(value, data) + '"').join('');
    if (attrs.disabled && (attrs.disabled.startsWith('{{') ? evaluate(attrs.disabled.slice(2, -2), data) : attrs.disabled === 'true')) htmlAttrs += ' disabled';
    if (attrs.bindtap) htmlAttrs += ' data-action="' + attrs.bindtap + '"';
    return '<' + tag + htmlAttrs + '>' + (tag === 'input' ? '' : render(node.children, data) + '</' + tag + '>');
  }).join('');
}

async function fixtures() {
  const cases = [];
  async function sample(name, prepare) {
    const s = roomPageFixture(), p = s.load({ mode: 'demo' }); await s.show(p);
    if (prepare) await prepare(s, p); p.onHide();
    cases.push([name, JSON.parse(JSON.stringify(p.data))]);
  }
  async function pair(s, p) { await p.createRoom(); await s.demo(p, 'partnerJoin'); }
  async function both(s, p) { await pair(s, p); await p.toggleReady(); await s.demo(p, 'partnerReady'); }
  await sample('create');
  await sample('config', async (_, p) => { p.toggleConfig(); p.chooseGrade({ currentTarget: { dataset: { value: 3 } } }); p.chooseRule({ detail: { value: 6 } }); });
  await sample('invalid-count', async (_, p) => { p.inputCount({ detail: { value: '' } }); await p.createRoom(); });
  await sample('join', async (_, p) => p.openJoin());
  await sample('waiting', async (_, p) => p.createRoom());
  await sample('ready', pair);
  await sample('both-host', both);
  await sample('both-guest', async (s, p) => { await both(s, p); await s.demo(p, 'switchRole'); });
  await sample('countdown', async (s, p) => { await both(s, p); await p.startMatch(); });
  await sample('full', async (_, p) => { p.openJoin(); p.inputRoomCode({ detail: { value: '111111' } }); await p.joinRoom(); });
  await sample('expired', async (_, p) => { p.openJoin(); p.inputRoomCode({ detail: { value: '222222' } }); await p.joinRoom(); });
  await sample('offline-two', async (s, p) => { await both(s, p); await p.startMatch(); await s.demo(p, 'disconnect'); });
  await sample('pending', async (_, p) => { p.openJoin(); p.inputRoomCode({ detail: { value: '333333' } }); await p.joinRoom(); });
  await sample('playing', async (s, p) => { await both(s, p); await p.startMatch(); await s.advance(3000); });
  const live = roomPageFixture(), p = live.load(); await live.show(p); await p.createRoom();
  await live.backend.call('b', 'join', { code: p.data.room.code }); await p.refreshRoom(); p.onHide();
  cases.push(['live-ready', JSON.parse(JSON.stringify(p.data))]);
  await live.show(p); await p.toggleReady();
  await live.backend.call('b', 'setReady', { roomId: p.data.room.roomId, expectedVersion: p.data.room.version, ready: true });
  await p.refreshRoom(); await p.startMatch();
  cases.push(['live-countdown', JSON.parse(JSON.stringify(p.data))]);
  await live.advance(3000);
  cases.push(['live-playing', JSON.parse(JSON.stringify(p.data))]);
  await live.advance(120000);
  cases.push(['live-awaiting-result', JSON.parse(JSON.stringify(p.data))]);
  p.onUnload();
  return cases;
}
function measure() {
  const issues = [], width = document.body.getBoundingClientRect().width;
  if (document.documentElement.scrollWidth > width + 1) issues.push('horizontal overflow');
  const controls = [...document.querySelectorAll('button,input,.room-picker')];
  const boxes = controls.map(element => ({ element, box: element.getBoundingClientRect() }));
  for (const { element, box } of boxes) {
    if (box.left < -0.75 || box.right > width + 0.75) issues.push('control outside viewport: ' + element.textContent.trim());
    if (box.height < 30 || box.width < 40) issues.push('control too small');
  }
  boxes.forEach((a, index) => boxes.slice(index + 1).forEach(b => {
    if (a.element.contains(b.element) || b.element.contains(a.element)) return;
    if (Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left) > 0.75 &&
      Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top) > 0.75) issues.push('controls overlap');
  }));
  for (const element of document.querySelectorAll('.room-member,.room-code,.room-heading,.member-status')) {
    if (element.scrollWidth > element.clientWidth + 1) issues.push('text exceeds allocated width');
  }
  const result = document.createElement('pre'); result.id = 'layout-result'; result.textContent = JSON.stringify(issues); document.body.append(result);
}

(async () => {
  const tree = parse(fs.readFileSync(path.join(root, 'pages/room/room.wxml'), 'utf8'));
  const styles = fs.readFileSync(path.join(root, 'app.wxss'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'pages/room/room.wxss'), 'utf8');
  const cases = await fixtures(), pages = [], failures = [];
  for (const width of [320, 375, 430]) for (const [name, data] of cases) {
    const css = styles.replace(/(^|\n)page\s*\{/g, '$1body {').replace(/([\d.]+)rpx/g, (_, n) => Number(n) * width / 750 + 'px');
    const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}#layout-result{display:none}body{margin:0;width:' + width + 'px}button,input{font-family:inherit}input{display:block}button:not([size=mini]){width:184px;margin-left:auto;margin-right:auto}' + css + '</style>' + render(tree, data) + '<script>(' + measure.toString() + ')();</script>';
    const file = path.join(output, width + '-' + name + '.html'); fs.writeFileSync(file, html); pages.push([width + '-' + name, html]);
  }
  async function check(pages) {
    if (!document.body) await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    const results = [];
    for (const [name, html] of pages) {
      const frame = document.createElement('iframe'); frame.style.width = name.split('-')[0] + 'px';
      const loaded = new Promise(resolve => frame.onload = resolve); frame.srcdoc = html; document.body.append(frame); await loaded;
      const element = frame.contentDocument.querySelector('#layout-result');
      results.push({ name, issues: element ? JSON.parse(element.textContent) : ['missing measurement'] }); frame.remove();
    }
    const result = document.createElement('pre'); result.id = 'room-layout-result'; result.textContent = JSON.stringify(results); document.body.append(result);
  }
  const harness = '(' + check.toString() + ')(' + JSON.stringify(pages) + ');';
  const file = path.join(output, 'layout-check.html');
  fs.writeFileSync(file, '<!doctype html><meta charset="utf-8"><script>' + harness.replace(/<\/script/gi, '<\\/script') + '</script>');
  const result = cp.spawnSync(browser, ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--user-data-dir=' + path.join(output, 'profile'), '--virtual-time-budget=10000', '--dump-dom', pathToFileURL(file).href], { encoding: 'utf8', timeout: 30000, maxBuffer: 6 * 1024 * 1024 });
  const match = (result.stdout || '').match(/<pre id="room-layout-result">([\s\S]*?)<\/pre>/);
  if (!match) throw new Error(result.error?.message || 'Missing browser layout results');
  const results = JSON.parse(match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  for (const item of results) if (item.issues.length) failures.push(item);
  console.log(JSON.stringify({ cases: results.length, passed: results.length - failures.length, failures, previewDirectory: output }, null, 2));
  if (failures.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
