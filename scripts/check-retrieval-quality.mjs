import {checkQuality} from '../data/retrieval-quality.mjs';
import {evaluate} from './evaluate-investigation-retrieval.mjs';
import {rankInvestigationCandidates as baseline} from '../fixtures/ranking-baseline-2026-10-30.mjs';
import {prepareAiContext as baselineContext} from '../fixtures/context-baseline-2026-10-30.mjs';
const checks=[];
for (const name of ['investigation-retrieval-holdout.json','investigation-retrieval-independent.json']) {
 const corpus=new URL('../fixtures/'+name,import.meta.url);
 const before=await evaluate(baseline,corpus,baselineContext);
 const after=await evaluate(undefined,corpus);
 for(const language of ['all','typescript','python','go']) {
  const a=before.summary[`holdout/${language}`],b=after.summary[`holdout/${language}`];
  checks.push({corpus:name,language,before:a,after:b,...checkQuality(a,b,language==='all')});
 }
}
console.log(JSON.stringify({passed:checks.every(c=>c.passed),note:'Null ratios remain unavailable. Unsendable tasks receive maximum contextLoss=1; valid tasks receive their measured waste ratio. First independent results are retained; repeated runs are regression checks.',checks},null,2));
if(checks.some(c=>!c.passed))process.exitCode=1;
