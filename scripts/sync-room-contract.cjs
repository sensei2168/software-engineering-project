const fs = require('node:fs');
const path = require('node:path');
const { RULES } = require('../miniapp/utils/practice-rules');
const { DURATIONS } = require('../miniapp/utils/practice-config');

const contract = {
  schemaVersion: 1,
  ruleVersion: '2026-10-27.1',
  durations: DURATIONS,
  rules: RULES.map(({ id, grade, operation, limit }) => ({ id, grade, operation, limit }))
};
const destination = path.join(__dirname, '../miniapp/cloudfunctions/roomService/rules.generated.json');
const content = JSON.stringify(contract, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8').replace(/\r\n/g, '\n') !== content) {
    console.error('房间配置契约未同步：运行 node scripts/sync-room-contract.cjs 后提交生成文件。');
    process.exitCode = 1;
  } else console.log('房间配置契约与现有年级题型设置一致。');
} else {
  fs.writeFileSync(destination, content);
  console.log('已同步房间配置契约；云函数部署包不依赖包外文件。');
}
