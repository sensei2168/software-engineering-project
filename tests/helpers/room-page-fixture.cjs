const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { fixture } = require('./room-fixture.cjs');
const filename = path.resolve(__dirname, '../../miniapp/pages/room/room.js');
const event = value => ({ currentTarget: { dataset: { event: value, value } }, detail: { value } });
async function settle() { for (let n = 0; n < 8; n++) await new Promise(resolve => setImmediate(resolve)); }

function roomPageFixture({ envVersion = 'develop', values = new Map(), backend = fixture(), actor = 'a' } = {}) {
  let clock = backend.time(), sequence = 0, definition, modal, clipboard = '';
  const callbacks = new Map(), requests = [], scrolls = [], state = { loseResponse: false, rejectCloud: false, gate: null, response: null, storageFailure: false };
  class MockDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const wxApi = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
    getStorageSync(key) { if (state.storageFailure) throw new Error('full'); return structuredClone(values.get(key)); },
    setStorageSync(key, value) { if (state.storageFailure) throw new Error('full'); values.set(key, structuredClone(value)); },
    removeStorageSync(key) { if (state.storageFailure) throw new Error('full'); values.delete(key); },
    showModal(options) { modal = options; },
    pageScrollTo(options) { scrolls.push(options.scrollTop); },
    setClipboardData(options) { clipboard = options.data; options.success(); },
    cloud: { init() {}, async callFunction({ data }) {
      requests.push(structuredClone(data));
      if (state.gate) await state.gate;
      if (state.rejectCloud) throw new Error('offline');
      const result = state.response || await backend.service(data, backend.context(actor));
      if (state.afterResponse) await state.afterResponse(result, data);
      if (state.loseResponse) { state.loseResponse = false; throw new Error('response lost'); }
      return { result };
    } }
  };
  function load(options = {}) {
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      require: createRequire(filename), Page(value) { definition = value; }, wx: wxApi, Date: MockDate,
      setInterval(callback) { callbacks.set(++sequence, callback); return sequence; },
      clearInterval(id) { callbacks.delete(id); }
    }, { filename });
    const page = { ...definition, data: structuredClone(definition.data), setData(patch) {
      Object.assign(this.data, JSON.parse(JSON.stringify(patch)));
    } };
    page.onLoad(options); return page;
  }
  return { backend, values, state, requests, scrolls, load, wxApi, event, settle,
    timers: () => callbacks.size, clipboard: () => clipboard, modal: () => modal,
    async show(page) { await page.onShow(); await settle(); },
    async advance(ms) { clock += ms; backend.advance(ms); for (const [id, run] of [...callbacks]) if (callbacks.has(id)) run(); await settle(); },
    async demo(page, name) { await page.demoEvent(event(name)); await settle(); },
    async confirm(yes) { const current = modal; modal = null; current.success({ confirm: yes, cancel: !yes }); await settle(); }
  };
}
module.exports = { roomPageFixture, event, settle };
