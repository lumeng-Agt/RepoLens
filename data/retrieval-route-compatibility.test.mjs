import test from 'node:test';
import assert from 'node:assert/strict';
import {rankInvestigationCandidates} from './question-retrieval.mjs';
import {createAiRouteRecord,aiRouteSignature} from './ai-route.mjs';
import {mergeSavedTours} from './reading-artifacts.mjs';
test('exact case wins and repeated identical names require range selection',()=>{
 const source='FindRoute\na\nb\nfindRoute\na\nb\nc';
 const input={files:[{id:'a',path:'a.go',symbolDetails:[{name:'FindRoute',startLine:1,endLine:3},{name:'findRoute',startLine:4,endLine:7}]}],dependencies:[],sourceById:new Map([['a',source]]),question:'FindRoute'};
 assert.deepEqual(rankInvestigationCandidates(input).candidates[0].suggestedRange,{startLine:1,endLine:3});
 input.files[0].symbolDetails[1].name='FindRoute';
 assert.equal(rankInvestigationCandidates(input).candidates[0].rangeRequired,true);
 assert.equal(rankInvestigationCandidates(input).candidates[0].suggestedRange,undefined);
});
test('conflicting route preserves nested compatible records and canonical signature',()=>{
 const steps=[{fileId:'a',purpose:'p',future:{v:1},references:[{fileId:'a',startLine:1,anchor:'a'},{fileId:'b',startLine:2,anchor:'b'}]}];
 const original=createAiRouteRecord({repositoryId:'r',title:'A',steps,contextFiles:[{fileId:'a',contentHash:'h',future:'c'}]});
 const incoming={...structuredClone(original),title:'B',future:'top'};
 const copy=mergeSavedTours([original],[incoming]).records[1];
 assert.deepEqual(copy.sourceSteps[0].future,{v:1});
 assert.equal(copy.sourceSteps[0].references[1].anchor,'b');
 assert.equal(copy.contextFiles[0].future,'c');
 assert.equal(copy.signature,aiRouteSignature(copy.title,copy.sourceSteps));
 assert.equal(copy.future,'top');
});
import {prepareAiContext} from './ai-context.mjs';
test('production context guard rejects ambiguity, history budget and excessive automatic candidates',()=>{
 const sourceById=new Map([['a','one\ntwo']]);
 const input={candidates:['a'],rankedCandidates:[{id:'a',rangeRequired:true}],sourceById,question:'q'};
 assert.equal(prepareAiContext(input).scopeRequired,true);
 assert.equal(prepareAiContext({...input,ranges:{a:{startLine:1,endLine:1}}}).scopeRequired,false);
 assert.equal(prepareAiContext({...input,rankedCandidates:[],history:[{content:'x'.repeat(60000)}]}).scopeRequired,true);
});
import {readFile} from 'node:fs/promises';
test('independent retrieval set contains 24 pinned tasks and at least 20 source files per repository',async()=>{
 const corpus=JSON.parse(await readFile(new URL('../fixtures/investigation-retrieval-holdout.json',import.meta.url),'utf8'));
 assert.equal(corpus.repositories.reduce((n,r)=>n+r.cases.length,0),24);
 for(const r of corpus.repositories){assert.match(r.commit,/^[a-f0-9]{40}$/);assert.ok(r.paths.length>=20);assert.equal(r.cases.length,8);assert.ok(r.files.some(f=>f.path===r.license&&f.source.length>100));for(const task of r.cases)for(const ref of task.required){const lines=r.files.find(f=>f.path===ref.path).source.split(/\r?\n/);assert.ok(ref.startLine>0&&ref.endLine<=lines.length);}}
});
