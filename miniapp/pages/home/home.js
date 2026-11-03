const { openPage } = require('../../utils/navigation');

Page({
  openPractice() { openPage('/pages/settings/settings'); },
  openRoom() { openPage('/pages/room/room'); },
  openHistory() { openPage('/pages/history/history'); }
});
