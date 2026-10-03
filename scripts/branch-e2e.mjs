/** Public SDK branch-summary E2E using installed provider; no private Pi APIs. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager } from "@earendil-works/pi-coding-agent";
const root=resolve(process.argv[2] || "/tmp/pi-chatgpt-web-branch-deep-20261003");
mkdirSync(root,{recursive:false});
const cwd=resolve(root,"work"),agentDir=resolve(root,"agent");
mkdirSync(cwd);mkdirSync(agentDir);
const provider=process.env.PI_STRESS_EXTENSION || resolve(process.env.HOME,".pi/agent/git/github.com/maemreyo/pi-chatgpt-web/extensions/chatgpt-web.js");
const settingsManager=SettingsManager.inMemory({packages:[],compaction:{enabled:false},retry:{enabled:true,maxRetries:2,baseDelayMs:100}});
const preparations=[];
const resourceLoader=new DefaultResourceLoader({cwd,agentDir,settingsManager,
  noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
  additionalExtensionPaths:[provider],
  extensionFactories:[(pi)=>{pi.on("session_before_tree", e=>{preparations.push({wantsSummary:e.preparation.userWantsSummary,entries:e.preparation.entriesToSummarize?.length});});}]
});
await resourceLoader.reload();
const {session,extensionsResult}=await createAgentSession({cwd,agentDir,settingsManager,resourceLoader,sessionManager:SessionManager.create(cwd,resolve(root,"sessions"))});
let report={case:"branch-summary",pass:false};
let timer;
const events=[];
session.subscribe(e=>{events.push(e);appendFileSync(resolve(root,"events.jsonl"),JSON.stringify(e)+"\n");});
const finalText=()=> {
  const turns=events.filter(e=>e.type==="turn_end"&&e.message?.role==="assistant");
  const m=turns.at(-1)?.message;
  assert(m&&m.stopReason!=="error"&&m.stopReason!=="aborted",m?.errorMessage);
  return m.content.filter(c=>c.type==="text").map(c=>c.text).join("").trim();
};
try {
  assert.equal(extensionsResult.errors.length,0,JSON.stringify(extensionsResult.errors));
  await session.bindExtensions({});
  const model=session.modelRuntime.getModel("chatgpt-web","gpt-5.6-sol");
  assert(model,"provider not registered");
  await session.setModel(model);session.setThinkingLevel("medium");
  timer=setTimeout(()=>{void session.abort();},6*60_000);
  await session.prompt("We are planning a toy project. The fixed base constraint is keep ports local. Reply only BASEOK. No tools.");
  await session.waitForIdle();assert.equal(finalText(),"BASEOK");
  const target=session.sessionManager.getLeafId();assert(target);
  const marker="BRANCH"+crypto.randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  await session.prompt("On this experimental branch, remember the unique decision token "+marker+" and the decision to use port 43127. Reply only BRANCHOK. No tools.");
  await session.waitForIdle();assert.equal(finalText(),"BRANCHOK");
  const result=await session.navigateTree(target,{summarize:true,customInstructions:"Preserve the unique BRANCH decision token and the chosen port from the abandoned branch."});
  assert.equal(result.cancelled,false);assert(!result.aborted,"branch summary aborted");
  assert(result.summaryEntry,"branch summary absent");
  const summary=result.summaryEntry.summary;
  assert(summary.includes(marker),"branch token lost");
  assert(summary.includes("43127"),"branch port lost");
  assert(!summary.includes("CODEX_LATEST_USER_PROMPT_JSON"),"control appendix leaked");
  await session.prompt("What unique BRANCH decision token and port were preserved from the branch? Reply only the token, one space, then the port. No tools.");
  await session.waitForIdle();assert.equal(finalText(),marker+" 43127");
  report={...report,pass:true,model:model.id,thinking:"medium",summaryChars:summary.length,recall:true,appendixAbsent:true,preparations,toolCalls:events.filter(e=>e.type==="tool_execution_start").length};
} catch(e) {report.error=e.stack;}
finally {
  clearTimeout(timer);await session.abort();session.dispose();
  writeFileSync(resolve(root,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
process.exitCode=report.pass?0:1;
