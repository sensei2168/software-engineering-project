const cloud = require('wx-server-sdk');
const { allowed, cleanExpired } = require('./cleanup');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database({ throwOnNotFound: false });
exports.main = async event => {
  // 调用权限还必须在控制台设为客户端不可调用；不开 HTTP 访问。
  if (!allowed(event, cloud.getWXContext(), process.env.ROOM_MAINTENANCE_ENABLED)) return { ok: false, error: 'MAINTENANCE_DISABLED_OR_FORBIDDEN' };
  try {
    return await cleanExpired({ store: {
      async listExpired(collection, field, cutoff, limit) {
        const result = await db.collection(collection).where({ [field]: db.command.lte(cutoff) }).limit(limit).get();
        return result.data.map(row => ({ id: row._id }));
      },
      transaction(run) { return db.runTransaction(async tx => run({
        async get(collection, id) { return (await tx.collection(collection).doc(id).get()).data; },
        async remove(collection, id) { await tx.collection(collection).doc(id).remove(); }
      }), 3); }
    } });
  } catch (_) { console.error('room-maintenance-failed'); return { ok: false, error: 'MAINTENANCE_FAILED' }; }
};
