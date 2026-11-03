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
const BATCH_LIMIT = 5;
const WORK_BUDGET_MS = 1200;
async function cleanExpired({ store, now = Date.now, dryRun = true }) {
  const cutoff = now(), counts = {};
  // 每次只查一个集合；若以后每5分钟调度，三个集合轮流得到执行机会。
  const target = TARGETS[Math.floor(cutoff / 60000) % TARGETS.length];
  counts[target.collection] = 0;
  const candidates = (await store.listExpired(target.collection, target.field, cutoff, BATCH_LIMIT)).slice(0, BATCH_LIMIT);
  let attempted = 0, stoppedForBudget = false;
  if (!dryRun) {
    for (const candidate of candidates) {
      // 协作式预算只限制新操作；不能保证已发出的数据库请求在3秒内返回。
      if (now() - cutoff >= WORK_BUDGET_MS) { stoppedForBudget = true; break; }
      attempted++;
      const removed = await store.transaction(async tx => {
        const current = await tx.get(target.collection, candidate.id);
        if (!current || !Number.isFinite(current[target.field]) || current[target.field] > cutoff) return false;
        if (now() - cutoff >= WORK_BUDGET_MS) { stoppedForBudget = true; return false; }
        await tx.remove(target.collection, candidate.id); return true;
      });
      if (removed) counts[target.collection]++;
    }
  }
  return { ok: true, mode: dryRun ? 'preview' : 'delete', cutoff, targetCollection: target.collection,
    candidates: candidates.length, attempted, removed: counts, batchLimit: BATCH_LIMIT,
    stoppedForBudget, elapsedMs: now() - cutoff,
    mayHaveMore: candidates.length === BATCH_LIMIT || stoppedForBudget };
}
module.exports = { allowed, cleanExpired, TARGETS, BATCH_LIMIT, WORK_BUDGET_MS };
