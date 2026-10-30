// 一次练习结果在「答题页 → 结果页」之间的交接。
//
// 用模块变量而不是全局对象：不污染 app.js，也不写进本地存储。
// 未确认提交的结果不应该落盘，只有结果页保存成功后才清除。
//
// 批改完成后调用 setPendingResult(...)，再跳转结果页即可。

let pendingResult = null;

function setPendingResult(result) {
  pendingResult = result;
}

// 只读取不清除：保存失败时仍能重试，不会因为多一次跳转就丢数据
function peekPendingResult() {
  return pendingResult;
}

function clearPendingResult(expectedId) {
  if (expectedId !== undefined) {
    const currentId = pendingResult && (pendingResult.practiceId || pendingResult.id);
    if (typeof currentId !== 'string' || currentId.trim() !== expectedId) return false;
  }
  pendingResult = null;
  return true;
}

module.exports = { setPendingResult, peekPendingResult, clearPendingResult };
