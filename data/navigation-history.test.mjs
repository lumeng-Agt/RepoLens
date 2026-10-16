import test from "node:test";
import assert from "node:assert/strict";
import { emptyNavigationHistory, moveNavigationHistory, pushNavigationHistory } from "./navigation-history.mjs";

test("navigation history stores source line locations and supports back and forward", () => {
  let history = pushNavigationHistory(emptyNavigationHistory, { fileId: "a.ts" }, { fileId: "b.ts", line: 12 });
  history = pushNavigationHistory(history, { fileId: "b.ts", line: 12 }, { fileId: "b.ts", line: 24, endLine: 26 });
  assert.equal(moveNavigationHistory(history, -1).location.line, 12);
  assert.equal(moveNavigationHistory(history, -2).location.fileId, "a.ts");
  assert.equal(moveNavigationHistory(moveNavigationHistory(history, -1).state, 1).location.line, 24);
});

test("new navigation after going back drops the forward branch and deduplicates locations", () => {
  let history = pushNavigationHistory(emptyNavigationHistory, { fileId: "a.ts" }, { fileId: "b.ts" });
  history = pushNavigationHistory(history, { fileId: "b.ts" }, { fileId: "c.ts" });
  const back = moveNavigationHistory(history, -1);
  const branched = pushNavigationHistory(back.state, back.location, { fileId: "d.ts" });
  assert.deepEqual(branched.entries.map((entry) => entry.fileId), ["a.ts", "b.ts", "d.ts"]);
  assert.equal(pushNavigationHistory(branched, { fileId: "d.ts" }, { fileId: "d.ts" }), branched);
});
