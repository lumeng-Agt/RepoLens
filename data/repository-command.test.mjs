import test from "node:test";
import assert from "node:assert/strict";
import { createRepositoryCommandIssuer, createRepositoryCommandRegistry } from "./repository-command.mjs";

test("repository command sequences invalidate older client intents without affecting another client", () => {
  const issuer = createRepositoryCommandIssuer("page-a");
  const firstOpen = issuer.next();
  const close = issuer.next();
  assert.deepEqual(firstOpen, { clientId: "page-a", intentSequence: 1 });
  assert.equal(issuer.isCurrent(firstOpen), false);
  assert.equal(issuer.isCurrent(close), true);

  const registry = createRepositoryCommandRegistry();
  assert.equal(registry.accept(firstOpen, "open"), "accepted");
  assert.equal(registry.accept({ clientId: "page-b", intentSequence: 1 }, "open"), "accepted");
  assert.equal(registry.accept(close, "close"), "accepted");
  assert.equal(registry.isCurrent(firstOpen, "open"), false);
  assert.equal(registry.isCurrent(close, "close"), true);
  assert.equal(registry.accept(close, "close"), "duplicate");
  assert.equal(registry.accept(close, "open"), "stale");
  assert.equal(registry.accept({ clientId: "page-a", intentSequence: Number.NaN }, "close"), "invalid");
  assert.equal(registry.isCurrent({ clientId: "page-b", intentSequence: 1 }, "open"), true);
});
