import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedExternalLink, isTrustedDesktopSender, isTrustedDesktopUrl } from "./security-policy.mjs";

const origin = "http://127.0.0.1:50001";

test("desktop window navigation stays on the exact local UI origin", () => {
  assert.equal(isTrustedDesktopUrl(`${origin}/index.html`, origin), true);
  assert.equal(isTrustedDesktopUrl("http://127.0.0.1:50002/index.html", origin), false);
  assert.equal(isTrustedDesktopUrl("https://127.0.0.1:50001/index.html", origin), false);
  assert.equal(isTrustedDesktopUrl("http://127.0.0.1:50001.evil.test/index.html", origin), false);
  assert.equal(isTrustedDesktopUrl("file:///C:/secret.html", origin), false);
});

test("desktop IPC accepts only the primary trusted renderer frame", () => {
  const primaryFrame = { url: `${origin}/` };
  const main = { get mainFrame() { return primaryFrame; } };
  assert.equal(isTrustedDesktopSender({ sender: main, senderFrame: primaryFrame }, main, origin), true);
  assert.equal(isTrustedDesktopSender({ sender: {}, senderFrame: primaryFrame }, main, origin), false);
  assert.equal(isTrustedDesktopSender({ sender: main, senderFrame: { url: `${origin}/` } }, main, origin), false);
  assert.equal(isTrustedDesktopSender({ sender: main, senderFrame: { url: "https://evil.test/" } }, main, origin), false);
  assert.equal(isTrustedDesktopSender({ sender: main, senderFrame: null }, main, origin), false);
});

test("desktop external links are limited to canonical GitHub HTTPS URLs", () => {
  assert.equal(isAllowedExternalLink("https://github.com/acme/demo"), true);
  assert.equal(isAllowedExternalLink("https://github.com/acme/demo/tree/main/src"), true);
  assert.equal(isAllowedExternalLink("http://github.com/acme/demo"), false);
  assert.equal(isAllowedExternalLink("https://evil.test/acme/demo"), false);
  assert.equal(isAllowedExternalLink("https://github.com.evil.test/acme/demo"), false);
  assert.equal(isAllowedExternalLink("https://user:pass@github.com/acme/demo"), false);
  assert.equal(isAllowedExternalLink("https://github.com:444/acme/demo"), false);
  assert.equal(isAllowedExternalLink("file:///C:/secret"), false);
});
