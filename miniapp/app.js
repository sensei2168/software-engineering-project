/**
 * 口算小搭档：小程序入口。
 *
 * 云开发环境 ID 配好后（utils/cloud-config.js），这里做一次全局初始化；
 * 没配之前不调用 wx.cloud，练习页会自动走本地兜底，不影响开发。
 */
const { CLOUD_ENV } = require('./utils/cloud-config');

App({
  onLaunch() {
    if (!CLOUD_ENV) return;
    if (!wx.cloud || !wx.cloud.init) {
      console.warn('[app] 基础库不支持云开发，练习页将使用本地出题');
      return;
    }
    try {
      wx.cloud.init({ env: CLOUD_ENV, traceUser: true });
    } catch (error) {
      console.warn('[app] 云开发初始化失败，练习页将使用本地出题', error);
    }
  }
});
