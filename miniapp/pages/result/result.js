const { computeSummary, toRows } = require('../../utils/result-stats');
const { saveRecord, getRecord } = require('../../utils/record-store');
const { peekPendingResult, clearPendingResult } = require('../../utils/practice-session');
const { toQuery, getConfigDisplay } = require('../../utils/practice-config');
const { openPage } = require('../../utils/navigation');
const { buildDevResult, canUseDevResult } = require('../../utils/dev-result-fixture');

// 结果页：展示一次练习的批改结果，并保存成一条本地记录。
//
// 三种进入方式：
//   1. 答题页提交后进入（预览本次结果，进入即尝试保存一次）；
//   2. 练习记录页点进来（?id=...，查看已保存记录详情，不重复保存）；
//   3. ?source=dev 使用开发测试数据（批改模块接入前验证页面）。

// 把练习配置转成一行摘要。规则名与范围来自 practice-rules，
// 只用于「本次练习」的说明；历史详情展示保存时的快照，
// 不会因为规则表以后改动而把旧题的描述改掉。
function configTextOf(config) {
  if (!config || !config.ruleId) return '';
  try {
    const display = getConfigDisplay(config);
    const parts = [display.gradeLabel, display.ruleLabel, display.rangeLabel];
    if (config.count) parts.push(config.count + ' 题');
    if (config.mode === 'timed') {
      parts.push('限时练习' + (config.durationSeconds ? ' ' + config.durationSeconds + ' 秒' : ''));
    } else {
      parts.push('普通练习');
    }
    return parts.filter(Boolean).join(' · ');
  } catch (e) {
    return '';
  }
}

Page({
  data: {
    mode: 'empty',      // empty 无结果 | preview 本次结果 | detail 历史详情
    isDev: false,
    devAllowed: false,
    summary: null,
    rows: [],
    metaText: '',
    configText: '',
    savedState: '',     // saving | saved | deduped | failed
    savedText: '',
    error: ''
  },

  onLoad(options) {
    const query = options || {};
    this.setData({ devAllowed: canUseDevResult() });

    if (query.id) {
      let id = query.id;
      try {
        id = decodeURIComponent(query.id);
      } catch (e) {
        // 解码失败就按原样使用，交给 getRecord 返回「未找到」
      }
      this.loadDetail(id);
      return;
    }

    if (query.source === 'dev') {
      this.onUseDevData();
      return;
    }

    const pending = peekPendingResult();
    if (pending) {
      this.renderResult(pending, 'preview');
      return;
    }

    this.setData({ mode: 'empty', error: '' });
  },

  loadDetail(id) {
    const result = getRecord(id);
    if (!result.ok) {
      this.setData({ mode: 'empty', error: result.error });
      return;
    }
    this.renderResult(result.record, 'detail');
  },

  renderResult(input, mode) {
    let summary;
    let rows;

    try {
      summary = computeSummary(input.items);
      rows = toRows(input.items);
    } catch (e) {
      this.setData({ mode: 'empty', error: e.message });
      return;
    }

    this.current = input;

    // 详情页优先使用保存时的摘要快照，避免用当前规则表改写旧记录
    const configText = mode === 'detail'
      ? (typeof input.configText === 'string' ? input.configText : '')
      : configTextOf(input.config);

    this.setData({
      mode: mode,
      isDev: input.isDevData === true,
      summary: summary,
      rows: rows,
      metaText: mode === 'detail' ? (input.createdAtText || '') : '刚刚完成',
      configText: configText,
      error: '',
      savedState: mode === 'detail' ? 'saved' : '',
      savedText: mode === 'detail' ? '该记录已保存在本机' : ''
    });

    // 让保存时把摘要一并写成快照
    this.current = Object.assign({}, input, { configText: configText });

    // 只有「本次结果」才自动保存；查看历史详情不重复写入
    if (mode === 'preview') this.saveNow(true);
  },

  // 保存本次记录。重复进入或重复点击都会再次调用，
  // 但同一 practiceId 只会写入一次，这正是「不产生重复记录」的验证点。
  saveNow(silent) {
    if (this.saving) return;
    if (!this.current) return;
    if (this.data.mode !== 'preview') return;

    this.saving = true;
    this.setData({ savedState: 'saving', savedText: '正在保存…' });

    const result = saveRecord(this.current);
    this.saving = false;

    if (result.ok) {
      // 保存成功后改用落库的记录（带 id 与保存时间）
      this.current = result.record;
      clearPendingResult(result.record.id);
      this.setData({
        savedState: result.deduped ? 'deduped' : 'saved',
        savedText: result.deduped ? '该次练习已保存过，没有重复记录' : '已保存到本机练习记录'
      });
      if (!silent) {
        wx.showToast({ title: result.deduped ? '已保存过，未重复记录' : '保存成功', icon: 'none' });
      }
      return;
    }

    // 保存失败如实说明，不显示「保存成功」
    this.setData({ savedState: 'failed', savedText: '保存失败：' + result.error });
    wx.showModal({
      title: '保存失败',
      content: result.error + '\n\n本次结果仍可查看，但关闭小程序后可能丢失。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  // 无结果时用开发测试数据预览页面
  onUseDevData() {
    if (!canUseDevResult()) {
      this.setData({ mode: 'empty', devAllowed: false, error: '当前版本不提供开发测试数据' });
      return;
    }
    this.renderResult(buildDevResult(), 'preview');
  },

  onSaveTap() {
    this.saveNow(false);
  },

  onAgain() {
    const config = this.current && this.current.config;
    if (config) {
      // 沿用本次的年级、题型与题量，直接回到答题页
      openPage('/pages/practice/practice?' + toQuery(config));
      return;
    }
    // 测试数据没有配置，回到设置页重新选择
    openPage('/pages/settings/settings');
  },

  onHistory() {
    openPage('/pages/history/history');
  },

  onHome() {
    wx.reLaunch({ url: '/pages/home/home' });
  }
});
