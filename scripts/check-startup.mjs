import { spawn } from 'node:child_process';
import { stopLocalService } from './stop-local-service.mjs';
import { createConnection, createServer } from 'node:net';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { preserveFailureEvidence } from './startup-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = path.join(os.tmpdir(), 'repolens-startup-evidence');
const repetitions = 3;

async function removeTemporary(target) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code) || attempt === 23) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(150 + attempt * 100, 900)));
    }
  }
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Could not reserve a local port.');
  return address.port;
}

async function waitForTcp(port, child, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Service exited before listening (code ${child.exitCode}).`);
    const connected = await new Promise((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Service did not open its port within ${timeoutMs}ms.`);
}

function startService(mode, uiPort, apiPort, logPath, persistPath) {
  const environment = {
    ...process.env,
    REPOLENS_PORT: String(apiPort),
    REPOLENS_UI_PORT: String(uiPort),
    NEXT_PUBLIC_REPOLENS_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
    REPOLENS_SERVER_LOG: logPath,
    VINEXT_NO_DEV_LOCK: '1',
  };
  const args = mode === 'development'
    ? ['scripts/with-local-service.mjs', 'scripts/run-framework.mjs', 'dev', '--host', '127.0.0.1', '--port', String(uiPort)]
    : [
      'scripts/with-local-service.mjs', '--import', './scripts/sites-env.mjs', './node_modules/wrangler/bin/wrangler.js',
      'dev', '--config', 'dist/server/wrangler.json', '--local', '--persist-to', persistPath,
      '--ip', '127.0.0.1', '--inspector-port', '0', '--port', String(uiPort),
    ];
  const child = spawn(process.execPath, args, { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: process.platform !== 'win32' });
  const pids = [];
  child.on('message', message => { if (message?.type === 'children') pids.push(...message.pids); });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  return { child, pids, getOutput: () => output };
}

async function browserProbe(browser, baseURL) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const evidence = { baseURL, failedRequests: [], badResponses: [], entryResponses: [], consoleErrors: [], pageErrors: [], runtimeErrors: [], navigations: [] };
  await page.addInitScript(() => {
    const errors = window.__startupErrors ??= [];
    window.addEventListener('error', (event) => errors.push(`window: ${event.message}`));
    window.addEventListener('unhandledrejection', (event) => errors.push(`promise: ${String(event.reason)}`));
  });
  page.on('requestfailed', (request) => evidence.failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? null }));
  page.on('response', (response) => {
    const item = { url: response.url(), status: response.status() };
    if (response.status() >= 400) evidence.badResponses.push(item);
    if (/browser-entry|__x00__virtual|page-[\w.-]+\.js|index-[\w.-]+\.js/.test(response.url())) evidence.entryResponses.push(item);
  });
  page.on('console', (message) => { if (message.type() === 'error') evidence.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  let thrown;
  try {
    for (const phase of ['first navigation', 'reload']) {
      evidence.navigations.push(phase);
      if (phase === 'first navigation') await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
      else await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: '第 1 步：从入口开始' }).waitFor({ timeout: 15_000 });
      await page.locator('.graph-file-card.is-selected').waitFor({ timeout: 15_000 });
      evidence.runtimeErrors = await page.evaluate(() => window.__startupErrors ?? []);
    }
    if (evidence.failedRequests.length || evidence.badResponses.length || evidence.consoleErrors.length || evidence.pageErrors.length || evidence.runtimeErrors.length) {
      thrown = new Error(`Browser startup produced errors: ${JSON.stringify(evidence)}`);
    }
  } catch (error) {
    thrown = error;
  }
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'repolens-startup-run-'));
  const tracePath = path.join(runRoot, 'browser-trace.zip');
  const screenshotPath = path.join(runRoot, 'browser.png');
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  await context.tracing.stop({ path: tracePath }).catch(() => {});
  await writeFile(path.join(runRoot, 'browser-diagnostics.json'), JSON.stringify({ ...evidence, error: thrown?.message ?? null }, null, 2));
  await context.close();
  if (thrown) throw Object.assign(thrown, { runRoot, evidence });
  return runRoot;
}

async function checkStart(mode, iteration, browser, scratchRoot) {
  const uiPort = await reservePort();
  const apiPort = mode === 'production' ? 4318 : await reservePort();
  const persistPath = path.join(scratchRoot, `wrangler-${mode}-${iteration}`);
  const logPath = path.join(scratchRoot, `service-${mode}-${iteration}.log`);
  const baseURL = `http://127.0.0.1:${uiPort}/`;
  const service = startService(mode, uiPort, apiPort, logPath, persistPath);
  let failure;
  let browserFailure;
  try {
    await waitForTcp(uiPort, service.child);
    browserFailure = await browserProbe(browser, baseURL);
  } catch (error) {
    failure = error;
    browserFailure = error.runRoot;
  } finally {
    try { await stopLocalService(service.child, service.pids); }
    catch (error) { failure = failure ? new AggregateError([failure, error], '启动与收尾检查失败。') : error; }
  }
  if (!failure) {
    if (browserFailure) await removeTemporary(browserFailure);
    await rm(logPath, { force: true });
    if (mode === 'production') await removeTemporary(persistPath);
    console.log(`PASS ${mode} cold start ${iteration}/${repetitions}: first navigation and reload succeeded without retry.`);
    return;
  }

  const diagnostics = browserFailure
    ? path.join(browserFailure, 'browser-diagnostics.json')
    : null;
  const screenshot = browserFailure ? path.join(browserFailure, 'browser.png') : null;
  const trace = browserFailure ? path.join(browserFailure, 'browser-trace.zip') : null;
  const saved = await preserveFailureEvidence({
    title: `${mode} cold start ${iteration}`,
    status: 'failed',
    errors: [{ message: failure.message, stack: failure.stack }],
    attachments: [
      ...(diagnostics ? [{ name: 'browser-diagnostics.json', path: diagnostics }] : []),
      ...(screenshot ? [{ name: 'browser.png', path: screenshot, contentType: 'image/png' }] : []),
      ...(trace ? [{ name: 'browser-trace.zip', path: trace, contentType: 'application/zip' }] : []),
      { name: 'service-output.txt', body: Buffer.from(service.getOutput()), contentType: 'text/plain' },
    ],
    serverLogPath: logPath,
    destinationRoot: evidenceRoot,
  });
  await rm(browserFailure ?? '', { recursive: true, force: true }).catch(() => {});
  await removeTemporary(persistPath);
  throw new Error(`${mode} cold start ${iteration} failed; evidence saved to ${saved.destination}: ${failure.message}`);
}

await access(path.join(root, 'dist/server/wrangler.json')).catch(() => {
  throw new Error('Production output is missing. Run `npm run build` before `npm run check:startup`.');
});

const scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'repolens-startup-check-'));
const browser = await chromium.launch();
try {
  for (const mode of ['development', 'production']) {
    for (let iteration = 1; iteration <= repetitions; iteration += 1) await checkStart(mode, iteration, browser, scratchRoot);
  }
} finally {
  await browser.close();
  await removeTemporary(scratchRoot);
}
