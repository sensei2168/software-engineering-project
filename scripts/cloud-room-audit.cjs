// 由微信自动化环境执行；只操作本次新建的测试房间，不读写现有页面缓存。
async function auditRoom(options) {
  const { envId, runId } = options;
  if (!/^[A-Za-z0-9-]{3,100}$/.test(envId) || !/^[a-z0-9-]{16,60}$/.test(runId)) throw new Error('Invalid audit options');
  const report = { startedAt: new Date().toISOString(), environmentId: envId,
    scope: 'single-real-account-concurrent-requests', cases: [], transientRetries: 0, cleanup: 'not-needed' };
  wx.cloud.init({ env: envId, traceUser: false });
  const request = (action, payload, suffix) => ({ action, payload, requestId: runId + '-' + suffix });
  async function send(data) {
    for (let i = 0; i < 3; i++) {
      try {
        const response = (await wx.cloud.callFunction({ name: 'roomService', config: { env: envId }, data })).result;
        if (!response || response.apiVersion !== 1 || typeof response.ok !== 'boolean') throw new Error('INVALID_RESPONSE');
        if (!response.ok && response.error.code === 'SERVICE_UNAVAILABLE' && i < 2) { report.transientRetries++; continue; }
        return response;
      } catch (_) {
        if (i === 2) throw new Error('CLOUD_CALL_FAILED');
        report.transientRetries++;
      }
    }
  }
  function check(name, passed) {
    report.cases.push({ name, passed: !!passed });
    if (!passed) throw new Error('ASSERTION_FAILED');
  }
  const config = { grade: 1, ruleId: 'g1_add_20', count: 10, durationSeconds: 60 };
  const create = request('create', { config }, 'create');
  let room, createAttempted = false;
  try {
    const identity = await send({ action: 'whoami' });
    check('expected-deployment', identity.ok && identity.data.environmentId === envId &&
      identity.data.stage === 'p4-room-start' && identity.data.capabilities.start);
    createAttempted = true;
    const created = await Promise.all([send(create), send(create), send(create)]);
    room = created.find(item => item.ok)?.data.room;
    check('concurrent-identical-create', room && created.every(item => item.ok &&
      item.data.room.roomId === room.roomId && item.data.room.code === room.code && item.data.room.version === 1) &&
      created.filter(item => item.ok && !item.data.operation.replayed).length === 1);
    // 再以原编号确认；这里只验证云端去重，不代表客户端断网恢复已通过。
    const replay = await send(create);
    check('same-request-recovery', replay.ok && replay.data.operation.replayed && replay.data.room.roomId === room.roomId);
    const conflict = await send({ ...create, payload: { config: { ...config, count: 11 } } });
    check('changed-payload-rejected', !conflict.ok && conflict.error.code === 'REQUEST_CONFLICT');
    const join = request('join', { code: room.code }, 'join');
    const joins = await Promise.all([send(join), send(join)]);
    check('same-identity-single-seat', joins.every(item => item.ok && item.data.room.members.length === 1 &&
      item.data.room.selfRole === 'host' && item.data.room.version === room.version));
    const start = await send(request('start', { roomId: room.roomId, expectedVersion: room.version }, 'start'));
    check('single-member-cannot-start', !start.ok && start.error.code === 'NEED_TWO_MEMBERS');
    const forged = await send(request('start', { roomId: room.roomId, expectedVersion: room.version, score: 100 }, 'forged'));
    check('client-score-rejected', !forged.ok && forged.error.code === 'INVALID_ARGUMENT');
    const leaves = [0, 1].map(i => request('leave', { roomId: room.roomId, expectedVersion: room.version }, 'leave' + i));
    const closed = await Promise.all(leaves.map(send));
    const winner = closed.findIndex(item => item.ok);
    check('competing-close', closed.filter(item => item.ok && item.data.closed).length === 1 &&
      closed.filter(item => !item.ok && item.error.code === 'ROOM_CLOSED').length === 1);
    const repeatLeave = await send(leaves[winner]);
    check('repeat-close', repeatLeave.ok && repeatLeave.data.closed && repeatLeave.data.operation.replayed);
  } catch (error) {
    report.failure = ['ASSERTION_FAILED', 'CLOUD_CALL_FAILED', 'INVALID_RESPONSE'].includes(error.message) ? error.message : 'AUDIT_FAILED';
  } finally {
    if (createAttempted) {
      try {
        // 即使首次响应全部丢失，也沿用原请求编号找回自己的测试房间。
        if (!room) { const recovered = await send(create); if (recovered.ok) room = recovered.data.room; }
        if (!room) throw new Error('Unconfirmed room');
        let current = await send({ action: 'get', payload: { roomId: room.roomId } });
        if (!current.ok) throw new Error('Cannot read room');
        if (current.data.room.status === 'waiting' && current.data.room.members.length === 1 && current.data.room.selfRole === 'host') {
          await send(request('leave', { roomId: room.roomId, expectedVersion: current.data.room.version }, 'cleanup'));
          current = await send({ action: 'get', payload: { roomId: room.roomId } });
        }
        report.cleanup = current.ok && current.data.room.status === 'cancelled' ? 'closed' : 'needs-review';
      } catch (_) { report.cleanup = 'needs-review'; }
    }
    report.finishedAt = new Date().toISOString();
    report.passed = !report.failure && report.cases.length === 9 && report.cases.every(item => item.passed) && report.cleanup === 'closed';
  }
  return report;
}
module.exports = { auditRoom };
