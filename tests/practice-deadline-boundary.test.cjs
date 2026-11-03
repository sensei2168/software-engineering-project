const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const file = path.resolve(__dirname, '../miniapp/pages/practice/practice.js');
const realRequire = createRequire(file);
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

async function harness(kind = 'integer', mode = 'timed') {
  let definition, time = 100000, resolveSubmit;
  const submissions = [], modals = [], timers = new Map(); let nextId = 0;
  const ruleId = kind === 'decimal' ? 'g3_decimal_1place' : kind === 'fraction' ? 'g3_fraction_same_den' : 'g1_add_20';
  const service = {
    async createQuestionSet() { return { ok: true, source: 'test', data: { quizId: 'deadline-test', questions: Array.from({ length: 10 }, (_, i) => ({ id: 'q' + i, text: 'test', ruleId, answerKind: kind })) } }; },
    submitAnswers(payload) { submissions.push(structuredClone(payload)); return new Promise(resolve => { resolveSubmit = resolve; }); }
  };
  class Clock extends Date { static now() { return time; } }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page(value) { definition = value; }, Date: Clock,
    require(name) { return name.includes('services/question-service') ? service : realRequire(name); },
    wx: { showModal(options) { modals.push(options); }, showToast() {} },
    console: { log() {}, error() {} }, setTimeout() {},
    setInterval(fn) { timers.set(++nextId, fn); return nextId; }, clearInterval(id) { timers.delete(id); }
  }, { filename: file });
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let target = this.data;
      for (const part of parts.slice(0, -1)) target = target[part];
      target[parts.at(-1)] = structuredClone(value);
    }
  } };
  page.onLoad({ grade: kind === 'integer' ? '1' : '3', ruleId, count: '10', mode, durationSeconds: '60' });
  await flush();
  return { page, submissions, modals, timers, advance(ms) { time += ms; },
    resolve(value) { resolveSubmit(value); }, input(value, part = 'numerator') {
      if (kind === 'fraction') page.onFractionInput({ currentTarget: { dataset: { part } }, detail: { value } });
      else page.onAnswerInput({ currentTarget: { dataset: { index: 0 } }, detail: { value } });
    } };
}

for (const kind of ['integer', 'decimal', 'fraction']) for (const offset of [60000, 60001]) {
  test(kind + ' rejects late input before timer callback at ' + offset + 'ms', async () => {
    const h = await harness(kind); h.input('1');
    if (kind === 'fraction') h.input('2', 'denominator');
    const before = h.page.answers[0]; h.advance(offset); h.input('9');
    assert.equal(h.page.answers[0], before);
    assert.equal(h.submissions.length, 1); assert.equal(h.submissions[0].answers[0], before);
    assert.equal(h.submissions[0].finishedBy, 'timeup'); assert.equal(h.page.data.remainingText, '00:00');
    h.input('8', 'denominator'); h.page.tick(); h.page.onSubmitTap();
    assert.equal(h.submissions.length, 1);
    h.resolve({ ok: false, message: 'retry later' }); await flush();
    assert.equal(h.page.data.deadlineLocked, true); assert.equal(h.timers.size, 0);
    h.input('7'); assert.equal(h.submissions.length, 1, 'input must not cause retry storm');
    h.page.onSubmitTap(); assert.equal(h.submissions.length, 2);
    assert.deepEqual(h.submissions[1].answers, h.submissions[0].answers);
    assert.equal(h.page.startTime, 100000); h.page.onUnload();
  });
}
test('confirmation opened before deadline submits as timeup when confirmed late', async () => {
  const h = await harness(); h.input('1'); h.page.onSubmitTap();
  assert.equal(h.modals.length, 1); assert.equal(h.submissions.length, 0);
  h.advance(60001); h.modals[0].success({ confirm: true }); h.page.tick();
  assert.equal(h.submissions.length, 1); assert.equal(h.submissions[0].finishedBy, 'timeup'); h.page.onUnload();
});
test('deadline manual submit accepts blank paper without showing pre-deadline warning', async () => {
  const h = await harness(); h.advance(60000); h.page.onSubmitTap();
  assert.equal(h.submissions.length, 1); assert.equal(h.submissions[0].finishedBy, 'timeup');
  assert.equal(h.modals.length, 0); h.page.onUnload();
});
test('ordinary mode remains editable and manual after 60 seconds', async () => {
  const h = await harness('integer', 'normal'); h.advance(90000); h.input('2');
  assert.equal(h.page.answers[0], '2'); assert.equal(h.submissions.length, 0);
  h.page.submit('manual'); assert.equal(h.submissions[0].finishedBy, 'manual'); h.page.onUnload();
});
test('pre-deadline input accepted; pending submission and unloaded modal cannot edit or resubmit', async () => {
  const h = await harness(); h.advance(59999); h.input('2'); h.page.onSubmitTap();
  const confirm = h.modals[0].success; confirm({ confirm: true }); h.input('9');
  assert.equal(h.page.answers[0], '2'); assert.equal(h.submissions[0].finishedBy, 'manual');
  h.page.onUnload(); confirm({ confirm: true }); assert.equal(h.submissions.length, 1);
});
