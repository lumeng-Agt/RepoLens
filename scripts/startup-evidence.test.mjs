import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { preserveFailureEvidence } from './startup-evidence.mjs';

test('failure evidence is preserved for any failed test with browser artifacts and service output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repolens-evidence-test-'));
  const serverLogPath = path.join(root, 'server.log');
  const attachmentPath = path.join(root, 'trace.zip');
  try {
    await writeFile(serverLogPath, 'dev server: client entry returned 500\n');
    await writeFile(attachmentPath, 'trace fixture');
    const evidence = await preserveFailureEvidence({
      title: 'ordinary navigation regression',
      status: 'failed',
      errors: [{ message: 'entry module failed', stack: 'stack fixture' }],
      attachments: [
        { name: 'trace', path: attachmentPath, contentType: 'application/zip' },
        { name: 'network-diagnostics.json', body: Buffer.from('{"status":500}'), contentType: 'application/json' },
      ],
      serverLogPath,
      destinationRoot: path.join(root, 'preserved'),
    });

    assert.equal((await readdir(evidence.destination)).sort().join(','), 'failure.json,network-diagnostics.json,service.log,trace.zip');
    const failure = JSON.parse(await readFile(path.join(evidence.destination, 'failure.json'), 'utf8'));
    assert.equal(failure.title, 'ordinary navigation regression');
    assert.equal(failure.errors[0].message, 'entry module failed');
    assert.match(await readFile(path.join(evidence.destination, 'service.log'), 'utf8'), /client entry returned 500/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an injected client-entry request failure is detected and archived with trace and server output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repolens-injected-entry-test-'));
  const browser = await chromium.launch();
  const serverLogPath = path.join(root, 'server.log');
  let serverOutput = '';
  const server = createServer((_request, response) => {
    serverOutput += 'GET / 200 fixture page\n';
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>entry fixture</title><script type="module" src="/browser-entry.js"></script>');
  });
  try {
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const page = await browser.newPage();
    const failedRequest = new Promise((resolve) => page.once('requestfailed', (request) => resolve({
      url: request.url(), error: request.failure()?.errorText ?? 'unknown',
    })));
    await page.route('**/browser-entry.js', async (route) => {
      serverOutput += 'GET /browser-entry.js 503 injected client-entry failure\n';
      await route.abort('failed');
    });
    await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const requestFailure = await failedRequest;
    assert.match(requestFailure.url, /browser-entry\.js/);

    const screenshot = await page.screenshot({ fullPage: true });
    const tracePath = path.join(root, 'browser-trace.zip');
    await page.context().tracing.stop({ path: tracePath });
    await writeFile(serverLogPath, serverOutput);
    const evidence = await preserveFailureEvidence({
      title: 'injected client-entry failure',
      status: 'failed',
      errors: [{ message: `${requestFailure.url}: ${requestFailure.error}` }],
      attachments: [
        { name: 'startup.png', body: screenshot, contentType: 'image/png' },
        { name: 'network-diagnostics.json', body: Buffer.from(JSON.stringify(requestFailure)), contentType: 'application/json' },
        { name: 'trace', path: tracePath, contentType: 'application/zip' },
      ],
      serverLogPath,
      destinationRoot: path.join(root, 'preserved'),
    });
    assert.equal((await readdir(evidence.destination)).sort().join(','), 'failure.json,network-diagnostics.json,service.log,startup.png,trace.zip');
    assert.match(await readFile(path.join(evidence.destination, 'service.log'), 'utf8'), /injected client-entry failure/);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});
