const { DEFAULT_CONFIG, DURATIONS, validateConfig, toQuery } = require('../../utils/practice-config');
const { openPage } = require('../../utils/navigation');

Page({
  data: {
    config: Object.assign({}, DEFAULT_CONFIG),
    countText: String(DEFAULT_CONFIG.count),
    durations: DURATIONS,
    error: ''
  },
  onLoad(options) {
    this.setData({ 'config.mode': options.mode === 'timed' ? 'timed' : 'normal' });
  },
  chooseOperation(event) {
    const operation = event.currentTarget.dataset.value;
    if (['add', 'subtract'].indexOf(operation) !== -1) {
      this.setData({ 'config.operation': operation, error: '' });
    }
  },
  chooseMode(event) {
    const mode = event.currentTarget.dataset.value;
    if (['normal', 'timed'].indexOf(mode) !== -1) this.setData({ 'config.mode': mode, error: '' });
  },
  chooseDuration(event) {
    const seconds = Number(event.currentTarget.dataset.value);
    if (DURATIONS.indexOf(seconds) !== -1) this.setData({ 'config.durationSeconds': seconds });
  },
  changeCount(event) {
    this.setData({ countText: event.detail.value, error: '' });
  },
  previewPractice() {
    const countText = this.data.countText.trim();
    if (!/^\d+$/.test(countText)) {
      this.setData({ error: '题量请输入 10 到 50 之间的整数' });
      return;
    }
    const result = validateConfig(Object.assign({}, this.data.config, { count: Number(countText) }));
    if (!result.ok) {
      this.setData({ error: result.message });
      return;
    }
    this.setData({ config: result.value, error: '' });
    openPage('/pages/practice/practice?' + toQuery(result.value));
  }
});
