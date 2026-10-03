import childProcess from "node:child_process";
import { existsSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const armPath = process.env.REPOLENS_TEST_GIT_CLOSE_ARM;
const enteredPath = process.env.REPOLENS_TEST_GIT_CLOSE_ENTERED;
const releasePath = process.env.REPOLENS_TEST_GIT_CLOSE_RELEASE;
const originalSpawn = childProcess.spawn;

childProcess.spawn = function spawnWithCloseGate(command, args, options) {
  if (!armPath || !enteredPath || !releasePath || path.basename(String(command)).toLowerCase().replace(/\.exe$/, "") !== "git" || !existsSync(armPath)) {
    return originalSpawn.call(this, command, args, options);
  }
  unlinkSync(armPath);
  const child = originalSpawn.call(this, command, args, options);
  const originalEmit = child.emit;
  let held = false;
  child.emit = function emitWithCloseGate(event, ...values) {
    if (event !== "close" || held) return originalEmit.call(this, event, ...values);
    held = true;
    writeFileSync(enteredPath, JSON.stringify({ command: String(command), args }));
    let watcher;
    const finish = () => {
      if (!existsSync(releasePath)) return;
      watcher?.close();
      child.emit = originalEmit;
      originalEmit.call(child, "close", ...values);
    };
    watcher = watch(path.dirname(releasePath), { persistent: false }, finish);
    finish();
    return true;
  };
  return child;
};

syncBuiltinESMExports();
