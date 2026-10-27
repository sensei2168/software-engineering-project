const { DEFAULT_CONFIG, DURATIONS, validateConfig, toQuery, fromQuery } = require('../../utils/practice-config');
const { GRADES, RULE_GROUPS, getRule, getRulesForGrade, getGradeLabel } = require('../../utils/practice-rules');
const { openPage } = require('../../utils/navigation');

function selectionSummary(config, countText, rule) {
  const text = countText.trim();
  const countLabel = /^\d+$/.test(text) && Number(text) >= 10 && Number(text) <= 50
    ? Number(text) + ' 道' : '题量待确认';
  return [getGradeLabel(config.grade), rule.label, countLabel,
    config.mode === 'timed' ? config.durationSeconds + ' 秒' : '不限时'].join(' · ');
}

Page({
  data: {
    config: Object.assign({}, DEFAULT_CONFIG),
    countText: String(DEFAULT_CONFIG.count),
    durations: DURATIONS,
    grades: GRADES,
    ruleGroups: RULE_GROUPS,
    selectedRule: getRule(DEFAULT_CONFIG.ruleId),
    visibleRules: getRulesForGrade(DEFAULT_CONFIG.grade),
    selectionSummary: selectionSummary(DEFAULT_CONFIG, String(DEFAULT_CONFIG.count), getRule(DEFAULT_CONFIG.ruleId)),
    notice: '',
    error: ''
  },
  onLoad(options = {}) {
    if (options.ruleId !== undefined || options.grade !== undefined || options.count !== undefined) {
      const restored = fromQuery(options);
      if (restored.ok) {
        this.updateSelection(restored.value, { countText: String(restored.value.count), error: '' });
        return;
      }
      this.updateSelection(Object.assign({}, DEFAULT_CONFIG), {
        countText: String(DEFAULT_CONFIG.count), error: '',
        notice: '上次练习设置无效，已恢复默认设置。'
      });
      return;
    }
    this.updateSelection(Object.assign({}, DEFAULT_CONFIG, {
      mode: options.mode === 'timed' ? 'timed' : 'normal'
    }), { countText: String(DEFAULT_CONFIG.count), error: '' });
  },
  updateSelection(config, options = {}) {
    const rule = getRule(config.ruleId);
    const countText = options.countText === undefined ? this.data.countText : options.countText;
    this.setData({
      config,
      countText,
      selectedRule: rule,
      visibleRules: getRulesForGrade(config.grade, rule.group),
      selectionSummary: selectionSummary(config, countText, rule),
      notice: options.notice || '',
      error: options.error === undefined ? this.data.error : options.error
    });
  },
  selectRule(rule, notice = '') {
    this.updateSelection(Object.assign({}, this.data.config, {
      grade: rule.grade, ruleId: rule.id, operation: rule.operation, limit: rule.limit
    }), { notice });
  },
  chooseGrade(event) {
    const grade = Number(event.currentTarget.dataset.value);
    if (grade === this.data.config.grade) return;
    const rules = getRulesForGrade(grade);
    if (!rules.length) return;
    const matching = rules.find((rule) => rule.operation === this.data.config.operation);
    this.selectRule(matching || rules[0], matching ? '' : '该年级未设置原题型，已切换为加法。');
  },
  chooseGroup(event) {
    const group = event.currentTarget.dataset.value;
    if (this.data.config.grade !== 3 || group === this.data.selectedRule.group) return;
    const rule = getRulesForGrade(3, group)[0];
    if (rule) this.selectRule(rule, '已切换为' + rule.label + '，题量和时长保持原选择。');
  },
  chooseRule(event) {
    const rule = getRule(event.currentTarget.dataset.value);
    if (rule && rule.grade === this.data.config.grade && rule.group === this.data.selectedRule.group) {
      this.selectRule(rule);
    }
  },
  chooseMode(event) {
    const mode = event.currentTarget.dataset.value;
    if (['normal', 'timed'].indexOf(mode) !== -1) {
      this.updateSelection(Object.assign({}, this.data.config, { mode }));
    }
  },
  chooseDuration(event) {
    const seconds = Number(event.currentTarget.dataset.value);
    if (DURATIONS.indexOf(seconds) !== -1) {
      this.updateSelection(Object.assign({}, this.data.config, { durationSeconds: seconds }));
    }
  },
  changeCount(event) {
    this.updateSelection(this.data.config, { countText: String(event.detail.value), error: '' });
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
    this.updateSelection(result.value, { countText: String(result.value.count), error: '' });
    openPage('/pages/practice/practice?' + toQuery(result.value));
  }
});
