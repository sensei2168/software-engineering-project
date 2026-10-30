const cloud = require('wx-server-sdk');
const { createCloudStore } = require('./store');
const { createRoomService } = require('./service');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database({ throwOnNotFound: false });
const handle = createRoomService({ store: createCloudStore(db), logError: code => console.error(code) });

exports.main = async event => handle(event, cloud.getWXContext());
