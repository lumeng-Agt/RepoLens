import { createInvestigation, replaceInvestigationResult } from "./investigation.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkModel, allowsNoKey, modelEndpoint } from './model-check.mjs';
import { buildRepositorySummary, retrieveFromSummary } from './summary-retrieval.mjs';
import { buildChatCompletionRequest } from './ai-generation.mjs';

test('model checks reject redirects, isolate fixed text and omit loopback authentication', async () => {
  assert.equal(modelEndpoint('https://gateway.test/custom/chat/completions', 'chat/completions'), 'https://gateway.test/custom/chat/completions');
  assert.equal(modelEndpoint('https://gateway.test/custom/chat/completions', 'models'), 'https://gateway.test/custom/models');
  const settings = { baseUrl: 'http://127.0.0.1:11434/v1', model: 'mock', authMode: 'none' };
  let requests = 0;
  const fetcher = async (url, init) => { requests++; assert.equal(init.redirect, 'manual'); assert.equal(init.headers.Authorization, undefined); assert.equal(JSON.parse(init.body).messages[0].content, 'Reply with OK.'); return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); };
  assert.deepEqual(await checkModel(settings, 'test', undefined, fetcher), { ok: true });
  await assert.rejects(checkModel({ ...settings, baseUrl: 'https://remote.example' }, 'test', undefined, fetcher), /回环/);
  assert.equal(requests, 1);
  await assert.rejects(checkModel(settings, 'test', undefined, async () => new Response('', { status: 307 })), /重定向/);
  assert.equal(allowsNoKey('http://127.0.0.1.evil.example'), false);
  await assert.rejects(checkModel(settings, 'test', undefined, async () => new Response('secret-from-malformed-server')), error => !error.message.includes('secret-from-malformed-server') && /JSON/.test(error.message));
});

test('model generation checks reject empty and whitespace-only answers', async () => {
  const settings = { baseUrl: 'http://127.0.0.1:11434/v1', model: 'mock', authMode: 'none' };
  const reply = content => async () => Response.json({ choices: [{ message: { content } }] });
  for (const content of ['', ' \n\t', null]) await assert.rejects(checkModel(settings, 'test', undefined, reply(content)), /有效文本/);
  assert.deepEqual(await checkModel(settings, 'test', undefined, reply('模型可以正常回答。')), { ok: true });
});

test('summary retrieval sends index only and rejects hallucinated files and symbols', async () => {
  const summary = buildRepositorySummary({ files: [{ id: 'store.py', path: 'store.py', source: 'SECRET SOURCE', symbolDetails: [{ name: 'save', startLine: 3, endLine: 8 }] }] });
  assert.equal(JSON.stringify(summary).includes('SECRET'), false);
  const settings = { baseUrl: 'http://localhost:1234/v1', model: 'mock', authMode: 'none' };
  const response = candidates => async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates }) } }] }));
  assert.deepEqual((await retrieveFromSummary(settings, summary, '保存', undefined, response([{ fileId: 'store.py', symbol: 'save', reason: '名称相关' }])))[0], { fileId: 'store.py', startLine: 3, endLine: 8, reason: '名称相关', basis: 'model-inference' });
  await assert.rejects(retrieveFromSummary(settings, summary, '保存', undefined, response([{ fileId: '../outside', reason: 'x' }])), /索引外/);
  await assert.rejects(retrieveFromSummary(settings, summary, '保存', undefined, response([{ fileId: 'store.py', symbol: 'absent', reason: 'x' }])), /索引外/);
});

test('refinement is untrusted user context, never a replacement system instruction', () => {
  const original = { title: 'old route', steps: [] };
  const request = buildChatCompletionRequest({ baseUrl: 'https://example.test/v1', model: 'mock', sources: [], entryFileId: 'a.ts', revision: 'r', refinement: { original, instruction: 'add error handling' } }, 'route');
  assert.doesNotMatch(request.body.messages[0].content, /old route/);
  assert.match(request.body.messages[1].content, /old route/);
  assert.match(request.body.messages[1].content, /add error handling/);
  assert.equal(original.title, 'old route');
});

test('applying refined investigation preserves extension fields and resets human review', () => {
  const result = { summary: 'old', items: [{ id: 'item', title: 'save', responsibility: 'storage', reason: 'old reason', references: [{ fileId: 'a.ts', startLine: 1 }] }], questions: [] };
  const latest = createInvestigation({ result, question: 'original requirement', repository: { id: 'repo', name: 'repo' }, contextFiles: [{ fileId: 'a.ts', contentHash: 'hash', startLine: 1, endLine: 2 }], id: 'old', now: 1 });
  latest.extension = { tag: 'keep' }; latest.items[0].extension = 'keep item'; latest.verifiedItemIds = ['item']; latest.checks = { item: 'checked' };
  const replacement = createInvestigation({ result: { ...result, summary: 'new' }, question: 'adjust this', repository: { id: 'repo', name: 'repo' }, contextFiles: latest.contextFiles, id: 'new', now: 2 });
  const applied = replaceInvestigationResult(latest, replacement, 3);
  assert.equal(applied.id, 'old'); assert.equal(applied.question, 'original requirement'); assert.equal(applied.summary, 'new');
  assert.deepEqual(applied.extension, { tag: 'keep' }); assert.equal(applied.items[0].extension, 'keep item'); assert.deepEqual(applied.verifiedItemIds, []); assert.deepEqual(applied.checks, {});
  assert.throws(() => replaceInvestigationResult(latest, { ...replacement, workspaceId: 'elsewhere' }), /工作区/);
});
