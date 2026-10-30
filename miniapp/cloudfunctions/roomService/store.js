// wx-server-sdk 4.0.2：事务回调返回值直接由 runTransaction 返回。
// db 必须以 throwOnNotFound:false 初始化；缺失文档为 data:null，其他错误继续抛出。
function createCloudStore(db) {
  return {
    transaction(run) {
      return db.runTransaction(async transaction => run({
        async get(collection, id) {
          const result = await transaction.collection(collection).doc(id).get();
          if (!result || !Object.prototype.hasOwnProperty.call(result, 'data')) throw new Error('Invalid database response');
          if (result.data === null) return null;
          const { _id, ...data } = result.data;
          return data;
        },
        async set(collection, id, data) {
          return transaction.collection(collection).doc(id).set({ data });
        }
      }), 3);
    }
  };
}
module.exports = { createCloudStore };
