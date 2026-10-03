import { bounded, stopLocalService } from "./stop-local-service.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.REPOLENS_GITHUB_SMOKE_URL ?? "https://github.com/sindresorhus/is";
const expectedLanguageInput = process.env.REPOLENS_GITHUB_SMOKE_EXPECT_LANGUAGE?.toLowerCase();
const expectedLanguage = ({ typescript: "ts", javascript: "js" })[expectedLanguageInput] ?? expectedLanguageInput;
const evidenceDirectory = process.env.REPOLENS_GITHUB_SMOKE_EVIDENCE_DIR;
const evidenceSlug = new URL(url).pathname.split("/").filter(Boolean).join("-").replace(/[^a-zA-Z0-9._-]/g, "-") || "repository";
const runDirectory = await mkdtemp(path.join(os.tmpdir(), "repolens-github-smoke-"));
const temporaryRoot = path.join(runDirectory, "content");
await mkdir(temporaryRoot);
if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitForApi(origin, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Local RepoLens services exited before becoming ready.");
    try { if ((await fetch(origin + "/api/health")).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local RepoLens service did not become ready.");
}
async function waitForTcp(port, child) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Local RepoLens UI exited before becoming ready.");
    const connected = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local RepoLens UI did not start listening within 30 seconds.");
}

const uiPort = await freePort();
const apiPort = await freePort();
const uiOrigin = "http://127.0.0.1:" + uiPort;
const apiOrigin = "http://127.0.0.1:" + apiPort;
const wrapper = path.join(projectRoot, "scripts", "with-local-service.mjs");
const framework = path.join(projectRoot, "scripts", "run-framework.mjs");
const serviceOutput = [];
const service = spawn(process.execPath, [wrapper, framework, "dev", "--port", String(uiPort)], {
  cwd: projectRoot,
  env: { ...process.env, REPOLENS_PORT: String(apiPort), REPOLENS_UI_PORT: String(uiPort), NEXT_PUBLIC_REPOLENS_API_ORIGIN: apiOrigin, REPOLENS_TEMP_ROOT: temporaryRoot },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  detached: process.platform !== "win32",
  windowsHide: true,
});
service.stdout.on("data", (chunk) => serviceOutput.push(chunk.toString("utf8")));
service.stderr.on("data", (chunk) => serviceOutput.push(chunk.toString("utf8")));
const childPids = [];
service.on("message", message => { if (message?.type === "children") childPids.push(...message.pids); });
let shutdownResult;
let browser;
let browserContext;
let activePage;
let lastRepositoryCommand;
let repositoryClosed = false;
let fallbackCloseStatus = null;
const runtimeErrors = [];
const failedRequests = [];
const apiResponses = [];
let primaryFailure;
const cleanupErrors = [];
let successResult;
try {
  await waitForApi(apiOrigin, service);
  await waitForTcp(uiPort, service);
  browser = await chromium.launch({ headless: true });
  browserContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...(evidenceDirectory ? { recordVideo: { dir: evidenceDirectory, size: { width: 1440, height: 900 } } } : {}),
  });
  await browserContext.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await browserContext.newPage();
  activePage = page;
  page.setDefaultTimeout(120_000);
  let modelRequests = 0;
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(message.text()); });
  page.on("request", (request) => {
    if (request.url().includes("/api/ai/generate")) modelRequests += 1;
    if (request.url().endsWith("/api/open") || request.url().endsWith("/api/close")) {
      try { lastRepositoryCommand = request.postDataJSON().command ?? lastRepositoryCommand; } catch {}
    }
    if (request.url().endsWith("/api/open")) {
      process.stdout.write("Opening repository through local service…\n");
    }
  });
  page.on("response", (response) => { if (response.url().includes("/api/")) apiResponses.push({ url: response.url(), status: response.status() }); });
  page.on("requestfailed", (request) => {
    if (request.url().includes("/api/")) failedRequests.push({ url: request.url(), error: request.failure()?.errorText });
  });
  if (process.env.REPOLENS_GITHUB_SMOKE_TEST_CLOSE_FAILURE === "1") {
    let injected = false;
    await page.route(apiOrigin + "/api/close", async (route) => {
      if (!injected && route.request().method() === "POST") {
        injected = true;
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Injected cleanup failure for smoke-test verification." }) });
      } else await route.continue();
    });
  }
  await page.goto(uiOrigin, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.locator(".graph-file-card").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.getByLabel("本地仓库路径或 GitHub 链接").fill(url);
  assert.equal(await page.getByRole("button", { name: "打开仓库" }).isEnabled(), true, "the repository URL should enable opening");
  const opened = page.waitForResponse((response) => response.url() === apiOrigin + "/api/open", { timeout: 120_000 });
  await page.getByRole("button", { name: "打开仓库" }).click();
  const openResponse = await opened;
  const snapshot = await openResponse.json();
  assert.equal(openResponse.status(), 200, "GitHub repository should open successfully: " + (snapshot.error ?? "unknown local-service error"));
  assert.equal(snapshot.origin?.kind, "github");
  assert.ok(snapshot.files.length > 0, "the public repository should contain readable source files");
  assert.ok(snapshot.origin.commit, "the page should resolve to a commit");
  const languageCounts = Object.fromEntries(snapshot.files.reduce((counts, file) => {
    const language = file.language ?? "unknown";
    counts.set(language, (counts.get(language) ?? 0) + 1);
    return counts;
  }, new Map()));
  if (expectedLanguage) {
    assert.ok(languageCounts[expectedLanguage] > 0, `the repository should include indexed ${expectedLanguage} sources`);
  }
  const resolvedDependencyCounts = Object.fromEntries(snapshot.dependencies.reduce((counts, edge) => {
    const resolution = edge.resolution ?? "unspecified";
    counts.set(resolution, (counts.get(resolution) ?? 0) + 1);
    return counts;
  }, new Map()));
  if (expectedLanguage === "python") {
    assert.ok(resolvedDependencyCounts.file > 0, "the Python project should include resolved file dependencies");
  }
  if (expectedLanguage === "go") {
    assert.ok(resolvedDependencyCounts.package > 0, "the Go project should include resolved package dependencies");
  }
  await page.getByText("GitHub 远端", { exact: true }).waitFor({ state: "visible" });
  await page.getByText(snapshot.origin.commit.slice(0, 12), { exact: false }).waitFor({ state: "visible" });
  const file = [...snapshot.files].sort((left, right) => left.path.localeCompare(right.path))[0];
  await page.getByRole("treeitem", { name: file.name, exact: true }).click();
  await page.getByRole("tab", { name: "源码", exact: true }).click();
  await page.locator(".source-code").waitFor({ state: "visible", timeout: 30_000 });
  const sourceText = await page.locator(".source-code").innerText();
  assert.ok(sourceText.length > 0, "source should be readable from the local service");
  if (evidenceDirectory) await page.screenshot({ path: path.join(evidenceDirectory, `${evidenceSlug}.png`) });
  const unchangedResponsePromise = page.waitForResponse((response) => response.url() === apiOrigin + "/api/rescan", { timeout: 120_000 });
  await page.getByRole("button", { name: "检查远端更新" }).first().click();
  const unchangedResponse = await unchangedResponsePromise;
  const unchangedSnapshot = await unchangedResponse.json();
  assert.equal(unchangedResponse.status(), 200, "the public GitHub no-change rescan should succeed: " + (unchangedSnapshot.error ?? "unknown local-service error"));
  assert.equal(unchangedSnapshot.id, snapshot.id, "a rescan preserves repository identity");
  assert.equal(unchangedSnapshot.origin?.commit, snapshot.origin.commit, "the remote commit stays unchanged");
  assert.equal(unchangedSnapshot.revision, snapshot.revision, "the content revision stays unchanged");
  assert.equal(unchangedSnapshot.sequence, snapshot.sequence, "the content sequence stays unchanged");
  assert.equal(modelRequests, 0, "the smoke check must not send source code to an AI service");
  assert.deepEqual(runtimeErrors, [], "the public repository should open without browser errors");
  const closedResponse = page.waitForResponse((response) => response.url() === apiOrigin + "/api/close", { timeout: 30_000 });
  await page.getByRole("button", { name: "返回示例" }).click();
  const closeResult = await closedResponse;
  assert.equal(closeResult.status(), 200, "returning to the sample must wait for successful remote cleanup");
  repositoryClosed = true;
  await page.getByText("示例仓库", { exact: true }).waitFor({ state: "visible" });
  assert.deepEqual(await readdir(temporaryRoot), [], "the close response must not precede temporary workspace cleanup");
  successResult = { url, commit: snapshot.origin.commit, resolvedRef: snapshot.origin.resolvedRef, revision: snapshot.revision, sequence: snapshot.sequence, unchangedRescan: true, files: snapshot.files.length, languages: languageCounts, dependencies: snapshot.dependencies.length, resolvedDependencies: resolvedDependencyCounts, openedSource: file.path, sourceCharacters: sourceText.length, aiRequests: modelRequests };
} catch (error) {
  primaryFailure = error;
} finally {
  if (!repositoryClosed && lastRepositoryCommand) {
    try {
      const closeCommand = { clientId: lastRepositoryCommand.clientId, intentSequence: lastRepositoryCommand.intentSequence + 1 };
      const response = await fetch(apiOrigin + "/api/close", { method: "POST", signal: AbortSignal.timeout(10_000), headers: { Origin: uiOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ command: closeCommand }) });
      fallbackCloseStatus = response.status;
      const result = await response.json();
      if (!response.ok) throw new Error(`烟测清理请求失败（${response.status}）：${result.error ?? "未知错误"}`);
      repositoryClosed = true;
    } catch (error) { cleanupErrors.push(error); }
  }
  if (browserContext) {
    if (activePage && !activePage.isClosed()) {
      try { await bounded(activePage.screenshot({ path: path.join(runDirectory, "last-page.png"), fullPage: true }), 10000, "保存烟测截图"); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { await bounded(browserContext.tracing.stop({ path: path.join(runDirectory, "trace.zip") }), 10000, "保存烟测 trace"); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (activePage && !activePage.isClosed()) {
    try { await bounded(activePage.close(), 5000, "关闭烟测页面"); } catch (error) { cleanupErrors.push(error); }
  }
  if (evidenceDirectory && activePage?.video()) {
    try {
      const target = path.join(evidenceDirectory, `${evidenceSlug}.webm`);
      await rm(target, { force: true });
      await activePage.video().saveAs(target);
    }
    catch (error) { cleanupErrors.push(error); }
  }
  if (browser) {
    try {
      await bounded(browser.close(), 5000, "关闭烟测浏览器");
      if (process.env.REPOLENS_GITHUB_SMOKE_TEST_BROWSER_CLOSE_FAILURE === "1") throw new Error("Injected browser close failure");
    } catch (error) { cleanupErrors.push(error); }
  }
  try { shutdownResult = await stopLocalService(service, childPids); } catch (error) { cleanupErrors.push(error); }
  try {
    const remaining = await readdir(temporaryRoot);
    if (remaining.length) throw new Error(`烟测结束后仍有临时内容：${remaining.join(", ")}`);
    await rm(temporaryRoot, { recursive: true, force: true });
  } catch (error) { cleanupErrors.push(error); }
  if (primaryFailure || cleanupErrors.length) {
    await writeFile(path.join(runDirectory, "diagnostics.json"), JSON.stringify({
      url,
      error: primaryFailure ? String(primaryFailure.stack ?? primaryFailure) : null,
      cleanupErrors: cleanupErrors.map((error) => String(error.stack ?? error)),
      apiResponses,
      failedRequests,
      runtimeErrors,
      serviceOutput: serviceOutput.join("").slice(-50_000),
      temporaryRoot,
      shutdownResult,
      childPids,
      repositoryClosed,
      fallbackCloseStatus,
    }, null, 2));
    process.stderr.write(`GitHub 烟测失败，证据保存在：${runDirectory}\n`);
  } else await rm(runDirectory, { recursive: true, force: true });
}
if (primaryFailure || cleanupErrors.length) throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...cleanupErrors], "GitHub 公开仓库烟测未通过。");
if (evidenceDirectory) await writeFile(path.join(evidenceDirectory, `${evidenceSlug}.json`), JSON.stringify(successResult, null, 2));
process.stdout.write(JSON.stringify({ ...successResult, repositoryClosed, shutdown: shutdownResult }) + "\n");
