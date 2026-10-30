const { createRoomService, COLLECTIONS, APP_ID } = require('../../miniapp/cloudfunctions/roomService/service');
const clone = value => value === undefined ? undefined : structuredClone(value);

// 串行事务模型用于检查业务不变量与回滚，不证明真实云数据库的并发隔离。
function memoryStore() {
  let records = new Map(), tail = Promise.resolve();
  const store = {
    failWrite: false, failAtWrite: 0,
    records(collection) { return [...records.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, data]) => clone(data)); },
    transaction(run) {
      const task = tail.then(async () => {
        let writeNumber = 0;
        const draft = new Map([...records].map(([key, value]) => [key, clone(value)]));
        const result = await run({
          async get(collection, id) { return clone(draft.get(collection + '/' + id)) || null; },
          async set(collection, id, data) {
            if (store.failWrite || ++writeNumber === store.failAtWrite) throw new Error('database credentials must stay private');
            draft.set(collection + '/' + id, clone(data));
          }
        });
        records = draft;
        return result;
      });
      tail = task.catch(() => {});
      return task;
    }
  };
  return store;
}

function fixture(options = {}) {
  let time = 1800000000000, sequence = 0, code = 100000;
  const store = memoryStore(), errors = [];
  const service = createRoomService({ store, now: () => time, randomCode: () => String(code++), logError: error => errors.push(error), ...options });
  const context = actor => ({ APPID: APP_ID, OPENID: actor, ENV: 'test-environment' });
  const id = () => 'request-' + String(++sequence).padStart(16, '0');
  const config = { grade: 1, ruleId: 'g1_add_20', count: 10, durationSeconds: 60 };
  const call = (actor, action, payload = {}, requestId = id()) => service({ action, payload, requestId }, context(actor));
  return { store, service, errors, context, id, config, call,
    time: () => time, advance(ms) { time += ms; },
    async create(actor = 'a', settings = config, requestId = id()) { return call(actor, 'create', { config: settings }, requestId); },
    async pair() {
      const created = await call('a', 'create', { config });
      const joined = await call('b', 'join', { code: created.data.room.code });
      return joined.data.room;
    },
    count(collection = COLLECTIONS.rooms) { return store.records(collection).length; }
  };
}

module.exports = { fixture, memoryStore };
