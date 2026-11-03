const { getRecord, saveRecord } = require('../../utils/record-store');
const { selectedItems, gradeCorrection } = require('../../utils/correction');
Page({
  data: { rows: [], error: '', submitted: false, saved: false, saving: false, resultId: '', summary: '' },
  onLoad(options = {}) {
    const loaded = getRecord(options.id || '');
    if (!loaded.ok) { this.setData({ error: loaded.error }); return; }
    try {
      this._record = loaded.record; this._items = selectedItems(loaded.record);
      this._id = 'correction-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      this._answers = this._items.map(() => '');
      this.setData({ rows: this._items.map((item,index) => ({ index, expression: item.expression, answer: '' })),
        error: this._items.length ? '' : '这条记录没有需要订正的题目。' });
    } catch (error) { this.setData({ error: error.message }); }
  },
  inputAnswer(event) {
    if (this.data.submitted) return;
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || !this._items[index]) return;
    this._answers[index] = String(event.detail.value);
    const rows = this.data.rows.slice(); rows[index] = { ...rows[index], answer: this._answers[index] };
    this.setData({ rows, error: '' });
  },
  submit() {
    if (this.data.submitted || this.data.saving || !this._items || !this._items.length) return;
    const items = [];
    for (let index = 0; index < this._items.length; index++) {
      const judged = gradeCorrection(this._items[index], this._answers[index]);
      if (!judged.ok) { this.setData({ error: '第' + (index + 1) + '题：' + judged.message }); return; }
      items.push({ ...this._items[index], userAnswer: judged.answer, status: judged.status });
    }
    const record = this._record;
    this._result = { practiceId: this._id, kind: 'correction', sourceRecordId: record.id, createdAt: Date.now(),
      ruleId: record.ruleId, ruleVersion: record.ruleVersion, config: record.config ? { ...record.config, mode: 'normal' } : null,
      configText: '原题订正 · 不限时 · ' + items.length + '题', items };
    this.setData({ submitted: true, summary: '本次答对 ' + items.filter(i => i.status === 'correct').length + ' / ' + items.length + ' 题。',
      rows: items.map((item,index) => ({ index, expression: item.expression, answer: item.userAnswer, correctAnswer: item.correctAnswer,
        statusText: ({ correct: '正确', wrong: '错误', unanswered: '未答' })[item.status] })) });
    this.save();
  },
  save() {
    if (!this._result || this.data.saving) return;
    this.setData({ saving: true });
    const saved = saveRecord(this._result);
    this.setData({ saving: false, saved: saved.ok, resultId: saved.ok ? saved.record.id : '', error: saved.ok ? '' : saved.error });
  },
  showResult() { if (this.data.saved) wx.redirectTo({ url: '/pages/result/result?id=' + encodeURIComponent(this.data.resultId) }); },
  goHome() { wx.reLaunch({ url: '/pages/home/home' }); }
});
