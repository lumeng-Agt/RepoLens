import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAiContext } from './ai-context.mjs';
import { rankInvestigationCandidates } from './question-retrieval.mjs';

test('a large picker does not block a strong default; explicit attachments remain intact', () => {
  const candidates = Array.from({length: 25}, (_, i) => `file-${i}`);
  const sourceById = new Map(candidates.map(id => [id, 'one\ntwo']));
  const rankedCandidates = candidates.map((id, i) => ({id, score: i ? 1 : 100, suggestedRange: {startLine: 1, endLine: 1}}));
  const input = {candidates, rankedCandidates, sourceById, question: 'save'};
  const automatic = prepareAiContext(input);
  assert.equal(automatic.scopeRequired, false);
  assert.deepEqual(automatic.sources.map(s => s.fileId), ['file-0']);
  const explicit = prepareAiContext({...input, fileIds: candidates});
  assert.equal(explicit.sources.length, 25);
  assert.deepEqual(explicit.blockers, ['file_limit']);
});

test('context reports simultaneous ambiguity and budget failures without a model request', () => {
  const result = prepareAiContext({candidates:['a'], rankedCandidates:[{id:'a',score:1,rangeRequired:true}], sourceById:new Map([['a','x']]), question:'q',history:[{content:'x'.repeat(60000)}]});
  assert.deepEqual(result.blockers, ['character_limit','ambiguous_definition']);
  assert.equal(prepareAiContext({candidates:[],sourceById:new Map(),retrievalInsufficient:true}).blockers[0], 'insufficient_evidence');
});

test('assignment function definitions produce complete ranges without whole-file context', () => {
  const source = 'const unrelated = 1;\napp.saveTask = function saveTask() {\n  persist();\n};\nconst other = 2;';
  const ranked = rankInvestigationCandidates({files:[{id:'a',path:'a.js'}],dependencies:[],sourceById:new Map([['a',source]]),question:'saveTask'});
  assert.deepEqual(ranked.candidates[0].suggestedRange, {startLine:2,endLine:4});
});
