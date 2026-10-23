function openPage(url) {
  wx.navigateTo({
    url,
    fail() {
      wx.showToast({ title: '页面打开失败，请返回首页重试', icon: 'none' });
    }
  });
}

module.exports = { openPage };
