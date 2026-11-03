const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { RULES } = require('../miniapp/utils/practice-rules');
const generator = require('../miniapp/utils/question/generator');
const store = require('../miniapp/utils/record-store');
const { selectedItems, gradeCorrection } = require('../miniapp/utils/correction');
const file = path.resolve(__dirname, '../miniapp/pages/practice/practice.js');

for (const rule of RULES) test(rule.id + ' practice grading -> saved snapshot -> correction -> separate history record', async t => {
  const storage = new Map();
  global.wx = { getStorageSync: key => structuredClone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)), showToast() {}, showModal() {} };
  t.after(() => { delete global.wx; });
  let definition;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: createRequire(file), Page: value => { definition = value; },
    wx: global.wx, console: { log() {}, error() {} }, Date, setTimeout() {} });
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  page.onLoad({ grade: String(rule.grade), ruleId: rule.id, count: '10', mode: 'normal', durationSeconds: '60' });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(page.questions.length, 10);
  const generated = generator.generateQuestions({ ruleId: rule.id, count: 10, sessionId: page.data.quizId });
  page.answers[0] = String(generated.questions[0].answer);
  await page.submit('manual');
  assert.equal(page.data.finished, true); assert.ok(page.savedRecordId);
  const original = store.getRecord(page.savedRecordId).record;
  assert.equal(original.summary.correct, 1); assert.equal(original.summary.unanswered, 9);
  const selected = selectedItems(original); assert.equal(selected.length, 9);
  const corrected = selected.map(item => {
    const result = gradeCorrection(item, item.correctAnswer);
    assert.equal(result.ok, true); assert.equal(result.status, 'correct');
    return { ...item, userAnswer: item.correctAnswer, status: result.status };
  });
  const saved = store.saveRecord({ practiceId: original.id + '-correction', kind: 'correction', sourceRecordId: original.id,
    config: original.config, ruleId: original.ruleId, ruleVersion: original.ruleVersion, items: corrected });
  assert.equal(saved.ok, true); assert.equal(saved.record.summary.correct, 9);
  assert.equal(store.loadRecords().records.length, 2);
  assert.deepEqual(store.getRecord(original.id).record, original);
  page.onUnload();
});
