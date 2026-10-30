const { loadRecords, clearRecords } = require('../../utils/record-store');
const { openPage } = require('../../utils/navigation');
const { canUseDevResult } = require('../../utils/dev-result-fixture');

// 练习记录页：读取本机保存的练习记录，点击可看详情。
// 每次显示都重新读存储，所以关闭小程序再打开也能看到已保存记录。
// 列表只使用记录自身的快照字段，不查当前规则表。

Page({
  data: {
    records: [],
    count: 0,
    empty: true,
    devAllowed: false,
    error: ''
  },

  // 用 onShow 而不是 onLoad：从详情页返回、清除记录后回到本页都要刷新
  onShow() {
    this.setData({ devAllowed: canUseDevResult() });
    this.refresh();
  },

  refresh() {
    const result = loadRecords();

    if (!result.ok) {
      this.setData({ records: [], count: 0, empty: true, error: result.error });
      return;
    }

    const records = result.records.map(function (record) {
      const summary = record.summary || {};
      const config = record.config || {};
      return {
        id: record.id,
        createdAtText: record.createdAtText || '',
        total: typeof summary.total === 'number' ? summary.total : (record.items ? record.items.length : 0),
        correct: typeof summary.correct === 'number' ? summary.correct : 0,
        accuracyText: summary.accuracyText || '0.0%',
        modeText: config.mode === 'timed' ? '限时' : '普通',
        isDevData: record.isDevData === true
      };
    });

    this.setData({
      records: records,
      count: records.length,
      empty: records.length === 0,
      error: ''
    });
  },

  onOpen(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    openPage('/pages/result/result?id=' + encodeURIComponent(id));
  },

  // 开发验证用：批改模块接入前，用测试数据看结果页。
  // 仅开发版／体验版可见，路由入口也再次校验版本。
  onViewDevResult() {
    if (!canUseDevResult()) return;
    openPage('/pages/result/result?source=dev');
  },

  onClear() {
    if (this.data.count === 0) {
      wx.showToast({ title: '暂无记录', icon: 'none' });
      return;
    }

    const that = this;
    // 清除前必须确认，避免误删
    wx.showModal({
      title: '清除全部记录',
      content: '将删除本机保存的 ' + this.data.count + ' 条练习记录，删除后无法恢复。确定继续吗？',
      confirmText: '清除',
      confirmColor: '#a43426',
      success(res) {
        if (!res.confirm) return;
        const result = clearRecords();
        if (!result.ok) {
          wx.showModal({ title: '清除失败', content: result.error, showCancel: false });
          return;
        }
        that.refresh();
        wx.showToast({ title: '已清除', icon: 'none' });
      }
    });
  },

  onHome() {
    wx.reLaunch({ url: '/pages/home/home' });
  }
});
