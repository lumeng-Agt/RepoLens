import { readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export function createModelSettingsStore(directory, encryption) {
  const file = path.join(directory, "model-settings.enc");
  let queue = Promise.resolve();
  return {
    async read() {
      let content;
      try { content = await readFile(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
      if (!encryption.isEncryptionAvailable()) throw new Error("系统加密服务不可用，无法恢复模型配置。");
      const value = JSON.parse(encryption.decryptString(content));
      if (value.version !== 1 || ![value.baseUrl, value.model, value.apiKey].every((part) => typeof part === "string")) throw new Error("保存的模型配置格式无效。");
      return { baseUrl: value.baseUrl, model: value.model, apiKey: value.apiKey };
    },
    save(settings) {
      const operation = queue.then(async () => {
        if (!encryption.isEncryptionAvailable()) throw new Error("系统加密服务不可用，模型配置未保存。");
        const temporary = `${file}.tmp`;
        try {
          if (!settings) { await rm(file, { force: true }); return; }
          const content = encryption.encryptString(JSON.stringify({ version: 1, ...settings }));
          await writeFile(temporary, content, { mode: 0o600 });
          await rename(temporary, file);
        } finally { await rm(temporary, { force: true }); }
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}
