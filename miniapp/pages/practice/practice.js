const { fromQuery } = require('../../utils/practice-config');

Page({
  data: { config: null, error: '' },
  onLoad(options) {
    const result = fromQuery(options);
    if (!result.ok) {
      this.setData({ error: '练习设置无效，请返回设置页面重新选择。' });
      return;
    }
    this.setData({ config: result.value, error: '' });
  }
});
