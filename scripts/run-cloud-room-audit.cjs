const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { auditRoom } = require('./cloud-room-audit.cjs');
// 只有明确提供 --run-live 才创建云端测试数据；自动化依赖由使用者在本机指定。
if (!process.argv.includes('--run-live')) throw new Error('Live check requires --run-live');
if (!process.env.MINIPROGRAM_AUTOMATOR_PATH) throw new Error('Set MINIPROGRAM_AUTOMATOR_PATH to installed miniprogram-automator');
const automator = require(process.env.MINIPROGRAM_AUTOMATOR_PATH);
const { envId } = require('../miniapp/config/cloud');
const outputDir = path.resolve(__dirname, '../.artifacts');
fs.mkdirSync(outputDir, { recursive: true });
const reportPath = path.join(outputDir, 'cloud-room-audit.json');
const runPath = path.join(outputDir, 'cloud-room-audit-run.json');
if (fs.existsSync(runPath) && (!fs.existsSync(reportPath) || JSON.parse(fs.readFileSync(reportPath, 'utf8')).cleanup !== 'closed')) {
  throw new Error('Previous audit cleanup is unconfirmed; recover its original request before creating another room');
}
const options = { envId, runId: 'audit-' + Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex') };
// 留下原请求前缀用于失败后的同号恢复，不能因连接中断直接换编号反复建房。
fs.writeFileSync(runPath, JSON.stringify(options, null, 2));
fs.writeFileSync(reportPath, JSON.stringify({ runId: options.runId, cleanup: 'unconfirmed', passed: false }, null, 2));
(async () => {
  let mini;
  const timer = setTimeout(() => { console.error('Audit timed out; inspect saved run before retrying'); process.exit(2); }, 90000);
  try {
    mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9431' });
    const report = await mini.evaluate(auditRoom, options);
    fs.writeFileSync(reportPath, JSON.stringify({ runId: options.runId, ...report }, null, 2));
    console.log(JSON.stringify(report));
    if (!report.passed) process.exitCode = 1;
  } catch (_) { console.error('Cloud audit unavailable; do not count as passed'); process.exitCode = 1; }
  finally { if (mini) await mini.disconnect(); clearTimeout(timer); }
})().finally(() => process.exit(process.exitCode || 0));
