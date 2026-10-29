// 使用实际 WXML/WXSS 和页面数据，复现小程序默认按钮尺寸的 CSS 级联。
// 这是浏览器布局回归检查，不替代微信真机渲染。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const cp = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../miniapp');
const browser = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!fs.existsSync(browser)) throw new Error('请用 CHROME_PATH 指定本机 Chrome 可执行文件');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-layout-'));

const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const evaluate = (expression, data) => vm.runInNewContext(expression, data, { timeout: 100 });
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
  let previousIf;
  return nodes.map(node => {
    if (node.text !== undefined) return interpolate(node.text, data);
    if (node.attrs['wx:else'] && previousIf === true) return '';
    if (node.attrs['wx:for']) {
      return evaluate(node.attrs['wx:for'].slice(2, -2), data).map((item, index) => {
        const copy = { ...node, attrs: { ...node.attrs } }; delete copy.attrs['wx:for'];
        return render([copy], { ...data, item, index });
      }).join('');
    }
    if (node.attrs['wx:if']) {
      previousIf = Boolean(evaluate(node.attrs['wx:if'].slice(2, -2), data));
      if (!previousIf) return '';
    } else if (!node.attrs['wx:else']) previousIf = undefined;
    const tag = ({ view: 'div', text: 'span', navigator: 'a' })[node.tag] || node.tag;
    const attrs = Object.entries(node.attrs).filter(([key]) => ['class', 'type', 'value', 'placeholder', 'maxlength'].includes(key))
      .map(([key, value]) => ` ${key}="${interpolate(value, data)}"`).join('');
    return `<${tag}${attrs}>${tag === 'input' ? '' : render(node.children, data) + `</${tag}>`}`;
  }).join('');
}
function pageData(ruleId, mode) {
  const config = require('../miniapp/utils/practice-config');
  const rule = require('../miniapp/utils/practice-rules').getRule(ruleId);
  const filename = path.join(root, 'pages/settings/settings.js');
  let definition;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: createRequire(filename), Page(value) { definition = value; }
  });
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(value) { Object.assign(this.data, value); }
  });
  const value = Object.assign({}, config.DEFAULT_CONFIG, {
    grade: rule.grade, ruleId: rule.id, operation: rule.operation, limit: rule.limit, mode
  });
  page.onLoad(Object.fromEntries(new URLSearchParams(config.toQuery(value))));
  return page.data;
}
function measure() {
  const issues = [], tolerance = 0.75;
  document.querySelectorAll('.type-cell').forEach((cell, index) => {
    const rect = cell.getBoundingClientRect(), style = getComputedStyle(cell);
    const button = cell.querySelector('button').getBoundingClientRect();
    const left = rect.left + parseFloat(style.paddingLeft), right = rect.right - parseFloat(style.paddingRight);
    if (Math.abs(button.left - left) > tolerance || Math.abs(button.right - right) > tolerance) issues.push('type cell ' + index + ' does not fit');
  });
  const buttons = [...document.querySelectorAll('.type-option')].map(el => el.getBoundingClientRect());
  buttons.forEach((a, index) => buttons.slice(index + 1).forEach(b => {
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > tolerance &&
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > tolerance) issues.push('type buttons overlap');
  }));
  document.querySelectorAll('.option-row').forEach(row => {
    const buttons = [...row.querySelectorAll('button')].map(el => el.getBoundingClientRect());
    for (let index = 1; index < buttons.length; index++) {
      if (buttons[index].left - buttons[index - 1].right < 1) issues.push('row buttons have no gap');
    }
  });
  const panel = document.querySelector('.settings-panel').getBoundingClientRect();
  const submit = document.querySelector('.settings-submit').getBoundingClientRect();
  if (Math.abs(panel.left - submit.left) > tolerance || Math.abs(panel.right - submit.right) > tolerance) issues.push('submit is not full width');
  const result = document.createElement('pre'); result.id = 'layout-result'; result.textContent = JSON.stringify(issues); document.body.append(result);
}

const source = fs.readFileSync(path.join(root, 'pages/settings/settings.wxml'), 'utf8');
const style = fs.readFileSync(path.join(root, 'app.wxss'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'pages/settings/settings.wxss'), 'utf8');
const cases = [
  ['g1_add_20', 'normal'], ['g2_divide_table', 'timed'],
  ['g3_mixed_2step', 'timed'], ['g3_fraction_same_den', 'timed']
];
const failures = [];
for (const width of [320, 375, 430]) {
  for (const [ruleId, mode] of cases) {
    const name = width + '-' + ruleId;
    const css = style.replace(/(^|\n)page\s*\{/g, '$1body {').replace(/([\d.]+)rpx/g, (_, n) => Number(n) * width / 750 + 'px');
    // 184px 及自动左右边距是本次需要覆盖的原生 button 尺寸。
    const html = '<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;width:'+width+'px}button{display:block;font-family:inherit;border:0}input{border:0;width:100%;font-family:inherit}'+css+'\nbutton:not([size=mini]){width:184px;margin-left:auto;margin-right:auto}</style>'+render(parse(source), pageData(ruleId, mode))+'<script>('+measure.toString()+')();</script>';
    const file = path.join(output, name + '.html'); fs.writeFileSync(file, html);
    const result = cp.spawnSync(browser, [
      '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
      '--user-data-dir=' + path.join(output, 'profile'), '--dump-dom', '--window-size='+width+',1200', pathToFileURL(file).href
    ], { timeout: 20000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const match = (result.stdout || '').match(/<pre id="layout-result">([\s\S]*?)<\/pre>/);
    if (!match) throw new Error(result.error?.message || result.stderr || 'Missing layout result');
    const issues = JSON.parse(match[1]);
    if (issues.length) failures.push({ name, issues });
  }
}
console.log(JSON.stringify({ cases: cases.length * 3, passed: cases.length * 3 - failures.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
