import path from "node:path";
import { createHash } from "node:crypto";
import { createRepositoryFileAccess } from "./repository-files.mjs";
export async function resolveEditorTarget(session, input) {
  if (!session || session.snapshot.origin || session.snapshot.source !== "local" || input.repositoryId !== session.snapshot.id || input.revision !== session.snapshot.revision || input.persistenceSessionId !== session.snapshot.persistenceSessionId) throw new Error("仓库会话已变化，或当前不是可编辑的本地仓库。");
  const file = session.snapshot.files.find(f => f.id === input.fileId);
  if (!file || !Number.isInteger(input.line) || input.line < 1 || typeof input.contentHash !== "string") throw new Error("源码位置无效，请重新定位。");
  const access = createRepositoryFileAccess(session.root);
  const inspected = access.inspectSync(file.path);
  const { content } = await inspected.readFile();
  const hash = createHash("sha256").update(content).digest("hex");
  if (hash !== input.contentHash || hash !== file.contentHash || input.line > content.split(/\r?\n/).length) throw new Error("源码已变化，请重新定位后再打开。");
  return { path: path.resolve(inspected.realPath), line: input.line };
}
