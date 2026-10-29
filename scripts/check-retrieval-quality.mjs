import {evaluate} from './evaluate-investigation-retrieval.mjs';
import {rankInvestigationCandidates as baseline} from '../fixtures/retrieval-baseline-2026-10-29.mjs';
const corpus=new URL('../fixtures/investigation-retrieval-holdout.json',import.meta.url);
const before=await evaluate(baseline,corpus);
const after=await evaluate(undefined,corpus);
const checks=[];
for(const language of ['all','typescript','python','go']){
 const a=before.summary[`holdout/${language}`],b=after.summary[`holdout/${language}`];
 checks.push({language,before:a,after:b,passed:b.recall5>=a.recall5&&b.necessaryCoverage>=a.necessaryCoverage&&b.rangeCoverage>=a.rangeCoverage&&(language !== "all" || b.recall5>a.recall5||b.necessaryCoverage>a.necessaryCoverage)&&b.irrelevantRatio!==null&&b.irrelevantRatio<a.irrelevantRatio});
}
console.log(JSON.stringify({passed:checks.every(c=>c.passed),note:'First independent results are retained separately; repeated runs are regression checks, not a new blind evaluation.',checks},null,2));
if(checks.some(c=>!c.passed))process.exitCode=1;
