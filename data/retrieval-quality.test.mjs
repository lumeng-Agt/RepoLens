import test from 'node:test';
import assert from 'node:assert/strict';
import { contextLoss, checkQuality } from './retrieval-quality.mjs';

test('missing output receives maximum loss and can never pass as efficient context', () => {
  assert.equal(contextLoss(true, null), 1);
  assert.equal(contextLoss(false, null), 1);
  const missing = {samples:8,recall5:1,necessaryCoverage:0,rangeCoverage:0,validSamples:0,irrelevantRatio:null,contextLoss:1};
  assert.equal(checkQuality(missing, missing).passed, false);
  const useful = {...missing,necessaryCoverage:0.75,rangeCoverage:0.75,validSamples:6,irrelevantRatio:0.1,contextLoss:0.325};
  assert.equal(checkQuality(missing, useful).passed, true);
  assert.equal(checkQuality(missing, {...useful,recall5:0.9}).passed, false);
  assert.equal(checkQuality(useful, {...useful,validSamples:7,irrelevantRatio:0.2,contextLoss:0.3}).passed, false);
});
