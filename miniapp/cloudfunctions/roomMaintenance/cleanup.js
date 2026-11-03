// 独立维护函数：固定集合、固定服务端截止、逐条事务复查，客户端不能指定删除对象。
const TARGETS = [
  { collection: 'room_p2_rooms', field: 'purgeAt' },
  { collection: 'room_p2_requests', field: 'purgeAt' },
  { collection: 'room_p2_codes', field: 'expiresAt' }
];
function allowed(event, identity, enabled) {
  return enabled === '1' && event && event.Type === 'Timer' && event.TriggerName === 'room-cleanup' && identity &&
    !identity.OPENID && !identity.FROM_OPENID && !identity.UNIONID && !identity.TCB_UUID &&
    !['wx_client', 'wx_devtools', 'wx_http', 'http'].includes(identity.SOURCE);
}
async function cleanExpired({ store, now = Date.now }) {
  const cutoff = now(), counts = {};
  for (const target of TARGETS) {
    counts[target.collection] = 0;
    const candidates = await store.listExpired(target.collection, target.field, cutoff, 20);
    for (const candidate of candidates) {
      const removed = await store.transaction(async tx => {
        const current = await tx.get(target.collection, candidate.id);
        if (!current || !Number.isFinite(current[target.field]) || current[target.field] > cutoff) return false;
        await tx.remove(target.collection, candidate.id); return true;
      });
      if (removed) counts[target.collection]++;
    }
  }
  return { ok: true, cutoff, removed: counts, batchLimitPerCollection: 20 };
}
module.exports = { allowed, cleanExpired, TARGETS };
