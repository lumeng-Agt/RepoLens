import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createModelSettingsStore } from './model-settings.mjs';

test('encrypted model configuration survives a new store instance and can be cleared', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'repolens-model-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = randomBytes(32);
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(value) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8'); },
  };
  const store = createModelSettingsStore(root, encryption);
  const settings = { baseUrl: 'https://model.example/v1', model: 'test-model', apiKey: 'test-secret-never-plain' };
  await store.save(settings);
  const raw = await readFile(path.join(root, 'model-settings.enc'));
  assert.equal(raw.includes(Buffer.from(settings.apiKey)), false);
  assert.deepEqual(await createModelSettingsStore(root, encryption).read(), settings);
  const unavailable = createModelSettingsStore(root, { ...encryption, isEncryptionAvailable: () => false });
  await assert.rejects(unavailable.save({ ...settings, apiKey: 'changed' }), /加密/);
  assert.deepEqual(await store.read(), settings, 'failed encryption preserves confirmed configuration');
  const local = { baseUrl: "http://127.0.0.1:11434/v1", model: "local", apiKey: "", authMode: "none" };
  await store.save(local);
  assert.deepEqual(await createModelSettingsStore(root, encryption).read(), local);
  await store.save(null);
  assert.equal(await store.read(), null);
});


test('without system encryption nothing is written, not even a plaintext fallback', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'repolens-model-settings-plain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const encryption = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('must not encrypt'); }, decryptString: () => { throw new Error('must not decrypt'); } };
  const store = createModelSettingsStore(root, encryption);
  await assert.rejects(store.save({ baseUrl: 'https://model.example/v1', model: 'm', apiKey: 'plain-secret-value' }), /加密/);
  assert.deepEqual(await readdir(root), [], 'no model-settings file or temporary file is left behind');
  await writeFile(path.join(root, 'model-settings.enc'), 'opaque');
  await assert.rejects(store.read(), /加密/, 'an existing file is reported as unreadable instead of being treated as unconfigured');
});
