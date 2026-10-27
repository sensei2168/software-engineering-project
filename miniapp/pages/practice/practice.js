const { fromQuery, toQuery, getConfigDisplay } = require('../../utils/practice-config');

Page({
  data: { config: null, display: null, error: '' },
  onLoad(options) {
    const result = fromQuery(options);
    if (!result.ok) {
      this.setData({ error: '练习设置无效，请返回设置页面重新选择。' });
      return;
    }
    this.setData({ config: result.value, display: getConfigDisplay(result.value), error: '' });
  },
  backToSettings() {
    const url = '/pages/settings/settings' + (this.data.config ? '?' + toQuery(this.data.config) : '');
    wx.navigateBack({
      delta: 1,
      fail() { wx.redirectTo({ url }); }
    });
  }
});
