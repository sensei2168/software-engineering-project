const { openPage } = require('../../utils/navigation');
const draft = require('../../utils/practice-draft');

Page({
  data: { hasDraft: false, draftError: '' },
  onShow() { const r = draft.read(); this.setData({ hasDraft: !!r.draft || !r.ok, draftError: r.error || '' }); },
  continuePractice() { openPage('/pages/practice/practice?resume=1'); },
  openPractice() {
    const r = draft.read();
    if (r.ok && !r.draft) { openPage('/pages/settings/settings'); return; }
    wx.showModal({ title: '重新开始练习？', content: '已有未完成的练习。重新开始会清除它的进度，限时练习的时间不会因退出而暂停。',
      confirmText: '重新开始', cancelText: '保留进度', success: result => {
        if (!result.confirm) return;
        const cleared = draft.clear();
        if (cleared.ok) openPage('/pages/settings/settings');
        else wx.showToast({ title: cleared.error, icon: 'none' });
      } });
  },
  openRoom() { openPage('/pages/room/room'); },
  openHistory() { openPage('/pages/history/history'); }
});
