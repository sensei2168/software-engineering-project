const { openPage } = require('../../utils/navigation');

Page({
  openNormal() { openPage('/pages/settings/settings?mode=normal'); },
  openTimed() { openPage('/pages/settings/settings?mode=timed'); },
  openRoom() { openPage('/pages/room/room'); },
  openHistory() { openPage('/pages/history/history'); }
});
