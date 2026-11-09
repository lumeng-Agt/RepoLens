/** Serializes settings and clears; receipts make retry safe after partial completion. */
export function createClearCoordinator({ store, deleteModel, beforeClear }) {
  const receipts = new Map();
  let queue = Promise.resolve();
  const run = operation => { const next = queue.then(operation); queue = next.catch(() => {}); return next; };
  return {
    run,
    clear(id, workspaceId) {
      const key = `${workspaceId ?? '*'}:${id}`;
      let receipt = receipts.get(key);
      if (!receipt) { receipt = { model: workspaceId ? undefined : false, workspace: false, copies: false }; receipts.set(key, receipt); }
      // Invalidate immediately, even when a settings write is ahead in the queue.
      // A copy-only/completed retry must preserve tasks and records created later.
      let preparation;
      if (!receipt.workspace) {
        try { preparation = Promise.resolve(beforeClear?.(workspaceId)).then(() => ({}), error => ({ error })); }
        catch (error) { preparation = Promise.resolve({ error }); }
      }
      return run(async () => {
        try {
          const prepared = await preparation;
          if (prepared?.error) throw prepared.error;
          if (!workspaceId && !receipt.model) { await deleteModel(); receipt.model = true; }
          if (!receipt.workspace) {
            const result = workspaceId ? await store.clearRepository(workspaceId) : await store.clearAll();
            receipt.workspace = result.persisted || result.cleared?.workspace === true;
            receipt.copies = result.persisted;
            if (!result.persisted) throw new Error(result.warning || '阅读记录未能清除。');
          } else if (!receipt.copies) {
            const result = await store.cleanCopies(workspaceId);
            receipt.copies = result.persisted;
            if (!result.persisted) throw new Error(result.warning);
          }
          return { ok: true, cleared: { ...receipt } };
        } catch (error) {
          const prefix = receipt.workspace ? '阅读记录已清除，保存副本未能清理' : receipt.model ? '模型配置已清除，阅读记录未能清除' : '清除未完成';
          return { ok: false, cleared: { ...receipt }, warning: `${prefix}：${error.message}` };
        }
      });
    },
  };
}
