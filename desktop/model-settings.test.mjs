import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  await store.save(null);
  assert.equal(await store.read(), null);
});
