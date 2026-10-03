/** Run installed /review against a fresh intentional bug, then its repaired successor. */
import { spawnSync } from "node:child_process";
import { mkdirSync,readFileSync,writeFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root=resolve(process.argv[2]);
const source=resolve(process.argv[3]);
mkdirSync(root,{recursive:false});
let script=readFileSync(source,"utf8");
if(process.env.PI_STRESS_REVIEW_EXTENSION){
 const extensions=["--no-extensions","--extension",resolve(process.env.PI_STRESS_REVIEW_EXTENSION),"--extension",resolve(process.env.PI_STRESS_EXTENSION)];
 script=script.replace('spawn("pi", [','spawn("pi", ['+extensions.map(v=>JSON.stringify(v)).join(",")+",");
}
assert(script.includes('const root = resolve(import.meta.dirname, "..");'),"review driver contract changed");
const driver=resolve(root,"driver.mjs");
writeFileSync(driver,script.replace('const root = resolve(import.meta.dirname, "..");',"const root = "+JSON.stringify(root)+";"));
const report={case:"review-integration",pass:false,cases:[]};
for (const [name,args] of [["bug",[]],["repaired",["--successor"]]]) {
 const result=spawnSync(process.execPath,[driver,...args],{encoding:"utf8",timeout:8*60_000});
 writeFileSync(resolve(root,name+".log"),result.stdout+"\n"+result.stderr);
 const path=resolve(root,".tmp",name==="bug"?"live-review.jsonl.summary.json":"live-successor.jsonl.summary.json");
 try {
  const summary=JSON.parse(readFileSync(path,"utf8"));
  const final=summary.results?.filter(r=>r.tool==="code_review_finalize"&&r.result?.details?.state==="FINALIZED").at(-1)?.result?.details?.report;
  const item={case:name,pass:summary.success===true&&result.status===0,candidate:summary.candidate,commandsVerified:summary.commandsVerified,
   tools:summary.executed,findings:final?.findings?.total,policyCoverage:final?.policy_coverage?.state,
   accountingComplete:final?.accounting?.complete,error:summary.error,timeout:summary.timeout||false,
   protocolErrors:(summary.results??[]).filter(r=>r.result?.details?.ok===false).map(r=>({tool:r.tool,code:r.result.details.error?.code})),
   baseContextEvidence:(summary.results??[]).filter(r=>r.tool==="code_review_context"&&r.result?.details?.material?.view==="base").map(r=>{const m=r.result.details.material;return {path:m.path,representation:m.representation,sha256:m.whole_object_sha256,receiptId:m.material_receipt_id,complete:m.complete};})};
  assert(summary.executed?.every(t=>t.startsWith("code_review_")),"review executed a non-review tool");
  report.cases.push(item);console.log(JSON.stringify(item));
 } catch(e) {report.cases.push({case:name,pass:false,error:e.message,status:result.status,signal:result.signal});}
 writeFileSync(resolve(root,"report.json"),JSON.stringify(report,null,2));
 if(!report.cases.at(-1).pass)break;
}
report.pass=report.cases.length===2&&report.cases.every(c=>c.pass);
writeFileSync(resolve(root,"report.json"),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));process.exitCode=report.pass?0:1;
