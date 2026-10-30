// 本地练习记录读写（本机存储，不建账号、不做云同步）。
//
// 三条硬要求：
//   1. 一次练习只保存一条记录；
//   2. 同一次练习重复触发保存时，不产生重复记录（以 practiceId 去重）；
//   3. 保存失败必须如实返回失败，不能显示虚假的「保存成功」。
//
// 按 docs/07 的约定，保存时同时写入 ruleId、规则版本与结构化原题快照，
// 历史展示只读这些快照，不用当前规则表重算旧题。
//
// 所有函数返回结果对象而不抛异常，页面据此显示提示。

const { computeSummary, isBlankAnswer, VALID_STATUS } = require('./result-stats');
const { RULE_VERSION } = require('./practice-rules');

const STORAGE_KEY = 'kousuan_practice_records_v1';
// 记录结构版本：字段发生变化时递增，便于以后兼容旧记录
const RECORD_SCHEMA_VERSION = 1;
// 规则版本统一来自题型目录；明确传入的旧版本不改写。
// 暂定只保留最近 100 次已提交练习，超出后删除最早的记录
const MAX_RECORDS = 100;

function getWx() {
  if (typeof wx === 'undefined' || !wx) return null;
  if (typeof wx.getStorageSync !== 'function' || typeof wx.setStorageSync !== 'function') return null;
  return wx;
}

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function formatDateTime(timestamp) {
  if (typeof timestamp !== 'number' || !isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return '';
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
    ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

// 读取原始数组；读取失败返回 ok:false，不静默当成空
function readRaw() {
  const api = getWx();
  if (!api) return { ok: false, error: '当前环境不支持本地存储' };

  let raw;
  try {
    raw = api.getStorageSync(STORAGE_KEY);
  } catch (e) {
    return { ok: false, error: '读取本地记录失败：' + ((e && e.errMsg) || (e && e.message) || '未知错误') };
  }

  if (raw === '' || raw === undefined || raw === null) return { ok: true, records: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: '本地记录格式异常，已保留原数据，请勿清除微信数据' };
  }
  try {
    const ids = new Set();
    raw.forEach(function (item) {
      if (!item || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id) ||
          item.schemaVersion !== RECORD_SCHEMA_VERSION || !Number.isFinite(item.createdAt)) {
        throw new Error('记录结构、编号或版本异常');
      }
      ids.add(item.id);
      const validated = buildRecord(item);
      if (stableJson(item.summary) !== stableJson(validated.summary)) throw new Error('统计数据不一致');
    });
  } catch (_) {
    return { ok: false, error: '本地记录损坏或版本不兼容，已保留原数据' };
  }
  return { ok: true, records: raw };
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sameContent(a, b) {
  // 重试可能重新取得保存时间，但同一练习的题目、答案和配置不能改变。
  const fields = ['id', 'schemaVersion', 'ruleId', 'ruleVersion', 'configText', 'config', 'isDevData', 'items', 'summary'];
  return fields.every(key => stableJson(a[key]) === stableJson(b[key]));
}

// 结构化原题快照：只保留可 JSON 化的数据，避免把页面对象写进存储
function snapshotQuestion(question) {
  if (question === null || question === undefined) return null;
  if (typeof question !== 'object') throw new Error('原题快照必须是对象');
  try {
    return JSON.parse(JSON.stringify(question));
  } catch (e) {
    throw new Error('原题快照无法保存，请检查题目数据');
  }
}

// 校验并规范化一条待保存记录。宁可保存失败，也不存一条残缺记录。
function buildRecord(input) {
  if (!input || typeof input !== 'object') throw new Error('记录内容为空');

  // 新结果用 practiceId；保存成功后的预览重试只有 id，仍沿用同一编号
  const practiceId = (typeof input.practiceId === 'string' && input.practiceId.trim() !== '')
    ? input.practiceId
    : input.id;
  if (typeof practiceId !== 'string' || practiceId.trim() === '') {
    throw new Error('缺少练习编号 practiceId，无法判断是否重复保存');
  }

  const items = input.items;
  if (!Array.isArray(items) || items.length === 0) throw new Error('本次练习没有题目，不能保存');

  const normalizedItems = items.map(function (item, index) {
    if (!item || typeof item !== 'object') throw new Error('第 ' + (index + 1) + ' 题数据为空');
    if (VALID_STATUS.indexOf(item.status) === -1) {
      throw new Error('第 ' + (index + 1) + ' 题缺少有效的结果状态');
    }
    if (item.correctAnswer === null || item.correctAnswer === undefined) {
      throw new Error('第 ' + (index + 1) + ' 题缺少正确答案');
    }
    return {
      // 可读算式快照，用于历史展示，不依赖规则表
      expression: String(item.expression || ''),
      // 结构化原题快照（如分数题的分母与两个分子），可选
      question: snapshotQuestion(item.question),
      // 空作答统一存 ''，0 保持为 '0'，两者不能混；
      // 精确答案按原样保存，不做数值归一化
      userAnswer: isBlankAnswer(item.userAnswer) ? '' : String(item.userAnswer).trim(),
      correctAnswer: String(item.correctAnswer),
      status: item.status
    };
  });

  // 统计在这里算一次并落库，记录页直接读，避免每次显示都重算口径
  const summary = computeSummary(normalizedItems);
  const createdAt = (typeof input.createdAt === 'number' && isFinite(input.createdAt))
    ? input.createdAt
    : Date.now();

  const config = snapshotQuestion(input.config);
  const ruleId = (typeof input.ruleId === 'string' && input.ruleId)
    ? input.ruleId
    : (config && typeof config.ruleId === 'string' ? config.ruleId : null);
  const ruleVersion = (typeof input.ruleVersion === 'string' && input.ruleVersion)
    ? input.ruleVersion
    : RULE_VERSION;

  return {
    id: practiceId.trim(),
    schemaVersion: RECORD_SCHEMA_VERSION,
    createdAt: createdAt,
    createdAtText: formatDateTime(createdAt),
    ruleId: ruleId,
    ruleVersion: ruleVersion,
    // 保存时的配置摘要快照：历史详情直接显示这段文字，
    // 不去查当前规则表，规则改名或调整也不会改写旧记录的说明。
    configText: (typeof input.configText === 'string' ? input.configText : ''),
    config: config,
    // 标记开发测试数据，记录列表里会显示标记，避免当成真实练习结果
    isDevData: input.isDevData === true,
    items: normalizedItems,
    summary: summary
  };
}

function saveRecord(input) {
  let record;
  try {
    record = buildRecord(input);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const read = readRaw();
  if (!read.ok) return { ok: false, error: read.error };

  // 幂等：同一次练习已存在时直接返回旧记录，不追加
  const existing = read.records.filter(function (item) { return item.id === record.id; })[0];
  if (existing) {
    if (!sameContent(existing, record)) return { ok: false, error: '同一练习编号已有不同内容，已保留原记录，请检查提交数据' };
    return { ok: true, deduped: true, record: existing, message: '该次练习已保存过，未重复写入' };
  }

  const api = getWx();
  if (!api) return { ok: false, error: '当前环境不支持本地存储' };

  const next = [record].concat(read.records).slice(0, MAX_RECORDS);
  try {
    api.setStorageSync(STORAGE_KEY, next);
  } catch (e) {
    const reason = (e && e.errMsg) || (e && e.message) || '未知错误';
    return { ok: false, error: '写入本地存储失败：' + reason };
  }

  // 回读确认：setStorageSync 可能没真正落盘（例如容量超限），不回读就无法保证「保存成功」是真的
  const verify = readRaw();
  if (!verify.ok) return { ok: false, error: '保存后校验失败：' + verify.error };
  const saved = verify.records.filter(function (item) { return item.id === record.id; })[0];
  if (!saved) return { ok: false, error: '保存未生效，本地未找到这条记录' };
  if (stableJson(saved) !== stableJson(record)) return { ok: false, error: '保存后内容校验不一致，请重试或检查本机存储' };

  return { ok: true, deduped: false, record: saved };
}

function loadRecords() {
  const read = readRaw();
  if (!read.ok) return { ok: false, records: [], error: read.error };
  return { ok: true, records: read.records };
}

function getRecord(id) {
  if (typeof id !== 'string' || id === '') return { ok: false, record: null, error: '记录编号为空' };
  const read = readRaw();
  if (!read.ok) return { ok: false, record: null, error: read.error };
  const found = read.records.filter(function (item) { return item.id === id; })[0];
  if (!found) return { ok: false, record: null, error: '未找到该记录，可能已被清除' };
  return { ok: true, record: found };
}

function countRecords() {
  const read = readRaw();
  return read.ok ? read.records.length : 0;
}

function clearRecords() {
  const api = getWx();
  if (!api) return { ok: false, error: '当前环境不支持本地存储' };
  try {
    if (typeof api.removeStorageSync === 'function') api.removeStorageSync(STORAGE_KEY);
    else api.setStorageSync(STORAGE_KEY, []);
  } catch (e) {
    return { ok: false, error: '清除记录失败：' + ((e && e.errMsg) || (e && e.message) || '未知错误') };
  }
  const verify = readRaw();
  if (!verify.ok || verify.records.length !== 0) return { ok: false, error: '清除后校验失败，不能确认记录已删除，请重试' };
  return { ok: true };
}

module.exports = {
  STORAGE_KEY,
  MAX_RECORDS,
  RECORD_SCHEMA_VERSION,
  RULE_VERSION,
  formatDateTime,
  buildRecord,
  saveRecord,
  loadRecords,
  getRecord,
  countRecords,
  clearRecords
};
