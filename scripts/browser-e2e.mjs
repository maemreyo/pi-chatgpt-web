/** Real Firefox model/tool integration, installed packages, bounded test-owned localhost fixture. */
import assert from "node:assert/strict";
import { mkdirSync,writeFileSync,appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import {createAgentSession,DefaultResourceLoader,SettingsManager,SessionManager} from "@earendil-works/pi-coding-agent";
const root=resolve(process.argv[2]);mkdirSync(root);
const cwd=resolve(root,"work"),agentDir=resolve(root,"agent");mkdirSync(cwd);mkdirSync(agentDir);
const installed=resolve(process.env.HOME,".pi/agent/git/github.com/maemreyo");
const posts=[];
const server=createServer((req,res)=>{
 if(req.method==="POST"&&req.url==="/clicked"){let body="";req.on("data",d=>body+=d);req.on("end",()=>{posts.push(body);res.end("OK");});return;}
 res.setHeader("Content-Type","text/html");res.end('<!doctype html><html><title>Pi Browser Stress Fixture</title><body><h1>Browser stress</h1><label>Token <input id="token" aria-label="Token"></label><button id="commit">Commit once</button><output id="result">WAITING</output><script>document.getElementById("commit").onclick=async()=>{const t=document.getElementById("token").value;await fetch("/clicked",{method:"POST",body:t});document.getElementById("result").textContent="COMMITTED "+t;document.getElementById("commit").textContent="COMMITTED "+t;};</script></body></html>');
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const url="http://127.0.0.1:"+server.address().port+"/";
const settingsManager=SettingsManager.inMemory({packages:[],compaction:{enabled:false},retry:{enabled:true,maxRetries:2,baseDelayMs:100}});
const resourceLoader=new DefaultResourceLoader({cwd,agentDir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
 additionalExtensionPaths:[process.env.PI_STRESS_EXTENSION || resolve(installed,"pi-chatgpt-web/extensions/chatgpt-web.js"),resolve(installed,"pi-browser/extensions/browser.ts")]});
await resourceLoader.reload();
const {session,extensionsResult}=await createAgentSession({cwd,agentDir,settingsManager,resourceLoader,sessionManager:SessionManager.create(cwd,resolve(root,"sessions")),noTools:"builtin",
 tools:["browser_status","browser_tabs","browser_snapshot","browser_act"]});
const events=[];session.subscribe(e=>{events.push(e);appendFileSync(resolve(root,"events.jsonl"),JSON.stringify(e)+"\n");});
let report={case:"firefox-integration",pass:false};let timer;
try {
 assert.equal(extensionsResult.errors.length,0,JSON.stringify(extensionsResult.errors));
 await session.bindExtensions({});
 await session.setModel(session.modelRuntime.getModel("chatgpt-web","gpt-5.6-sol"));session.setThinkingLevel("medium");
 const token="UI"+crypto.randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
 timer=setTimeout(()=>{void session.abort();},7*60_000);
 await session.prompt("Test the authorized Firefox browser with browser tools only. Call browser_status. Open "+url+" with browser_tabs (op open, active false; omit attention_policy, because preserve-user-attention forbids closing the fixture); use only the newly provider-owned fixture context. Take a snapshot, fill Token with "+token+" using its snapshot ref, take a fresh snapshot if needed, click Commit once exactly once using a valid ref. Re-snapshot until COMMITTED "+token+" is visible. Close that owned tab, then call browser_tabs op owned to verify zero tabs remain owned by this runtime. Do not touch any other tabs or change authorization. Finally reply only BROWSERSTRESSOK.");
 await session.waitForIdle();
 const calls=events.filter(e=>e.type==="tool_execution_start");
 const results=events.filter(e=>e.type==="tool_execution_end");
 const last=events.filter(e=>e.type==="turn_end"&&e.message?.role==="assistant").at(-1)?.message;
 assert(last&&last.stopReason!=="error"&&last.stopReason!=="aborted",last?.errorMessage);
 assert.equal(last.content.filter(c=>c.type==="text").map(c=>c.text).join("").trim(),"BROWSERSTRESSOK");
 assert.deepEqual(posts,[token],"fixture click must reach server exactly once");
 for(const name of ["browser_status","browser_tabs","browser_snapshot","browser_act"])assert(calls.some(e=>e.toolName===name),"missing tool "+name);
 const status=results.find(e=>e.toolName==="browser_status");
 assert(JSON.stringify(status?.result?.details).toLowerCase().includes("firefox"),"no Firefox identity");
 const owned=results.filter(e=>e.toolName==="browser_tabs"&&Array.isArray(e.result?.details?.owned_context_ids)).at(-1);
 assert(owned,"owned check absent");assert.deepEqual(owned.result.details.owned_context_ids,[]);
 assert(results.some(e=>e.toolName==="browser_snapshot"&&JSON.stringify(e.result).includes("COMMITTED "+token)),"post-click snapshot absent");
 report={...report,pass:true,model:"gpt-5.6-sol",thinking:"medium",provider:"firefox",clickRequests:posts.length,ownedAfter:0,tools:calls.map(e=>e.toolName),toolErrors:results.filter(e=>e.isError).length};
} catch(e) {report.error=e.stack;report.clickRequests=posts.length;report.browserOutcomes=events.filter(e=>e.type==="tool_execution_end"&&e.result?.details?.ok===false).map(e=>({tool:e.toolName,error:e.result.details.error}));}
finally {
 clearTimeout(timer);await session.abort();
 // Cleanup invokes the public tool definition from this session: lease checks still apply.
 // Only contexts opened by this runtime can appear in its owned result.
 try {
   const tabs=session.getToolDefinition("browser_tabs");
   if(tabs) {
     const owned=await tabs.execute(crypto.randomUUID(),{op:"owned"},AbortSignal.timeout(10000));
     const ids=owned.details?.owned_context_ids || [];
     for(const context_id of ids) await tabs.execute(crypto.randomUUID(),{op:"close",context_id},AbortSignal.timeout(10000));
     const after=await tabs.execute(crypto.randomUUID(),{op:"owned"},AbortSignal.timeout(10000));
     report.cleanupOwnedAfter=after.details?.owned_context_ids?.length;
     if(report.cleanupOwnedAfter!==0){report.pass=false;report.cleanupError="owned fixture tabs remain";}
   }
 } catch(e) {report.cleanupError=e.message;report.pass=false;}
 session.dispose();await new Promise(r=>server.close(r));
 writeFileSync(resolve(root,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
process.exit(report.pass?0:1);
