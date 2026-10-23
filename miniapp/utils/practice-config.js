// 第一轮配置预览只开放 20 以内加减法；并非已核实的年级教学标准。
const DEFAULT_CONFIG = {
  operation: 'add',
  limit: 20,
  count: 30,
  mode: 'normal',
  durationSeconds: 120
};
const DURATIONS = [60, 120, 180];

function validateConfig(input) {
  if (!input || ['add', 'subtract'].indexOf(input.operation) === -1) {
    return { ok: false, message: '请选择加法或减法' };
  }
  if (input.limit !== 20) return { ok: false, message: '当前预览仅支持 20 以内' };
  if (!Number.isInteger(input.count) || input.count < 10 || input.count > 50) {
    return { ok: false, message: '题量请输入 10 到 50 之间的整数' };
  }
  if (['normal', 'timed'].indexOf(input.mode) === -1) {
    return { ok: false, message: '请选择普通练习或限时练习' };
  }
  if (DURATIONS.indexOf(input.durationSeconds) === -1) {
    return { ok: false, message: '请选择 60、120 或 180 秒' };
  }
  return { ok: true, value: {
    operation: input.operation, limit: input.limit, count: input.count,
    mode: input.mode, durationSeconds: input.durationSeconds
  } };
}

function toQuery(config) {
  return Object.keys(config).map((key) => key + '=' + encodeURIComponent(config[key])).join('&');
}

function fromQuery(query) {
  return validateConfig({
    operation: query.operation, limit: Number(query.limit),
    count: Number(query.count), mode: query.mode,
    durationSeconds: Number(query.durationSeconds)
  });
}

module.exports = { DEFAULT_CONFIG, DURATIONS, validateConfig, toQuery, fromQuery };
