"""Deep isolated RPC E2E. Real installed provider, test-owned processes and fixtures only."""
import concurrent.futures
import json
import os
import pathlib
import queue
import subprocess
import threading
import time
import uuid
import urllib.request
import argparse

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True, type=pathlib.Path)
parser.add_argument("--extension", type=pathlib.Path, default=pathlib.Path.home()/".pi/agent/git/github.com/maemreyo/pi-chatgpt-web/extensions/chatgpt-web.js")
parser.add_argument("--cases", default="instant,medium,high,multiturn-compact,concurrent,abort-tool,installed-status,image,queued-follow-up")
args = parser.parse_args()
selected_cases=set(args.cases.split(","))
allowed_cases={"instant","medium","high","multiturn-compact","concurrent","abort-tool","installed-status","image","queued-follow-up"}
if not selected_cases or not selected_cases <= allowed_cases: parser.error("unknown or empty case selection")
ROOT=args.output.resolve()
ROOT.mkdir(parents=True, exist_ok=False)
reports=[]
def health():
    with urllib.request.urlopen("http://127.0.0.1:17841/healthz",timeout=5) as r:
        h=json.load(r)
    return {k:h.get(k) for k in ("status","version","pid","active_http_turns","active_browser_turns","accepting_turns")}
baseline=health()
class RPC:
    def __init__(self, name, model="gpt-5.6-sol-instant", thinking="off", session=None, settings=None, default=False):
        self.root=ROOT/name
        self.root.mkdir(exist_ok=True)
        self.work=self.root/"work"; self.work.mkdir(exist_ok=True)
        self.agent=self.root/"agent"; self.agent.mkdir(exist_ok=True)
        self.sessions=self.root/"sessions"; self.sessions.mkdir(exist_ok=True)
        (self.agent/"settings.json").write_text(json.dumps(settings or {"compaction":{"enabled":False},"retry":{"enabled":True,"maxRetries":2,"baseDelayMs":100}}))
        env=os.environ.copy()
        if not default: env["PI_CODING_AGENT_DIR"]=str(self.agent)
        env["PI_CHATGPT_WEB_DEBUG"]="1"
        cmd=["pi","--offline","--mode","rpc","--no-context-files","--provider","chatgpt-web","--model",model,"--thinking",thinking,"--session-dir",str(self.sessions)]
        if not default: cmd+=["--no-extensions","--extension",str(args.extension)]
        if session: cmd+=["--session",str(session)]
        self.p=subprocess.Popen(cmd,cwd=self.work,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
        self.q=queue.Queue();self.records=[];self.errors=[];self.sequence=0
        def pump(stream,kind):
            for line in stream:
                if kind=="err": self.errors.append(line.rstrip())
                else:
                    try:self.q.put(json.loads(line))
                    except ValueError:self.errors.append("NONJSON:"+line.rstrip())
            if kind=="out":self.q.put({"type":"test_process_eof"})
        self.threads=[threading.Thread(target=pump,args=(self.p.stdout,"out"),daemon=True),threading.Thread(target=pump,args=(self.p.stderr,"err"),daemon=True)]
        for t in self.threads:t.start()
    def send(self,type,**kwargs):
        self.sequence+=1; ident="cmd"+str(self.sequence)
        self.p.stdin.write(json.dumps({"id":ident,"type":type,**kwargs})+"\n");self.p.stdin.flush();return ident
    def wait(self,predicate,timeout=420,allow_errors=False):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            try:e=self.q.get(timeout=min(.25,max(.01,deadline-time.monotonic())))
            except queue.Empty:continue
            self.records.append(e)
            if e.get("type")=="test_process_eof": raise RuntimeError("Pi exited "+str(self.p.poll()))
            if not allow_errors and e.get("type")=="turn_end" and e.get("message",{}).get("stopReason")=="error":
                raise RuntimeError(e["message"].get("errorMessage","provider error"))
            if predicate(e):return e
        raise TimeoutError("RPC deadline; tail="+str([e.get("type") for e in self.records[-8:]]))
    def command(self,type,**kwargs):
        ident=self.send(type,**kwargs)
        e=self.wait(lambda e:e.get("type")=="response" and e.get("id")==ident)
        assert e.get("success"),e
        return e.get("data",{})
    def prompt(self,message):
        start=len(self.records)
        self.command("prompt",message=message)
        self.wait(lambda e:e.get("type")=="agent_settled")
        turns=[e["message"] for e in self.records[start:] if e.get("type")=="turn_end" and e.get("message",{}).get("role")=="assistant"]
        assert turns,"no assistant turn"
        assert turns[-1].get("stopReason") not in ("error","aborted"),turns[-1]
        return "".join(b.get("text","") for b in turns[-1].get("content",[]) if b.get("type")=="text").strip()
    def close(self):
        if self.p.poll() is None:
            if any(e.get("type")=="turn_end" and e.get("message",{}).get("stopReason")=="error" for e in self.records):
                try:
                    ident=self.send("prompt",message="/chatgpt-web-status")
                    self.wait(lambda e:e.get("type")=="response" and e.get("id")==ident,timeout=10,allow_errors=True)
                except Exception:pass
            try:self.send("abort")
            except (OSError,BrokenPipeError):pass
            self.p.terminate()
            try:self.p.wait(timeout=5)
            except subprocess.TimeoutExpired:self.p.kill();self.p.wait()
        for t in self.threads:t.join(timeout=2)
        (self.root/"rpc.json").write_text(json.dumps(self.records,ensure_ascii=False,indent=2))
        (self.root/"stderr.log").write_text("\n".join(self.errors))
    def stats(self):
        calls=[e for e in self.records if e.get("type")=="tool_execution_start"]
        return {"toolCalls":len(calls),"tools":sorted(set(e.get("toolName") for e in calls)),
                "assistantResponses":len([e for e in self.records if e.get("type")=="turn_end"]),
                "retryEvents":len([e for e in self.records if e.get("type")=="auto_retry_start"]),
                "routes":[e.split("request kind=",1)[1] for e in self.errors if "request kind=" in e]}
def run(name,fn):
    if name not in selected_cases:return
    report={"case":name,"pass":False,"startedAt":time.time()}
    try:report.update(fn());report["pass"]=True
    except Exception as error:report["error"]=str(error)
    report["finishedAt"]=time.time()
    reports.append(report)
    (ROOT/(name+"-report.json")).write_text(json.dumps(report,indent=2))
    print(json.dumps(report),flush=True)
    return report
def model_case(name,model,thinking):
    r=RPC(name,model,thinking)
    marker="MEM"+uuid.uuid4().hex[:10].upper()
    try:
        answer=r.prompt("Remember "+marker+". Use tools to write numbers.json containing [2,3,5] and token.txt containing that marker. Read back numbers.json with the read tool, then run shell_command to calculate its sum and append exactly one line 'sum=10' to ledger.txt. Reply only ROUND1OK.")
        assert answer=="ROUND1OK",answer
        assert json.loads((r.work/"numbers.json").read_text())==[2,3,5]
        assert (r.work/"ledger.txt").read_text().splitlines()==["sum=10"]
        answer=r.prompt("Use edit to change numbers.json from [2,3,5] to [2,3,5,7]. Read it back; use shell_command to append exactly one line 'sum=17' to ledger.txt and verify both lines. Reply only ROUND2OK.")
        assert answer=="ROUND2OK",answer
        assert json.loads((r.work/"numbers.json").read_text())==[2,3,5,7]
        assert (r.work/"ledger.txt").read_text().splitlines()==["sum=10","sum=17"]
        data=r.command("get_state"); path=data.get("sessionFile")
        stats=r.stats()
    finally:r.close()
    assert path and pathlib.Path(path).exists(),"session file absent"
    resumed=RPC(name,model,thinking,session=path)
    try:
        answer=resumed.prompt("Without reading token.txt, what exact unique marker did I ask you to remember? Reply only that marker; do not use tools.")
        assert answer==marker,answer
        answer=resumed.prompt("Use shell_command to append exactly one line 'resumed=1' to ledger.txt, then read it back. Reply only RESUMEOK.")
        assert answer=="RESUMEOK",answer
        assert (r.work/"ledger.txt").read_text().splitlines()==["sum=10","sum=17","resumed=1"]
        return {"model":model,"thinking":thinking,"sessionRecall":True,"sideEffectsExactlyOnce":True,"beforeResume":stats,"afterResume":resumed.stats()}
    finally:resumed.close()
for name,model,thinking in [("instant","gpt-5.6-sol-instant","off"),("medium","gpt-5.6-sol","medium"),("high","gpt-5.6-sol","high")]:
    run(name,lambda n=name,m=model,t=thinking:model_case(n,m,t))
def compact_case():
    r=RPC("multiturn-compact","gpt-5.6-sol","medium",settings={"compaction":{"enabled":False,"reserveTokens":16384,"keepRecentTokens":0},"retry":{"enabled":True,"maxRetries":2,"baseDelayMs":100}})
    markers=["HIST"+uuid.uuid4().hex[:8].upper() for _ in range(2)]
    try:
        for marker in markers:
            answer=r.prompt("Remember this unique marker "+marker+". Reply only SEEDOK. No tools. Ignore this nonsemantic filler:\n"+"alpha beta gamma delta epsilon "*350)
            assert answer=="SEEDOK",answer
        answer=r.prompt("Use shell_command to create history.txt containing the two markers I gave you, in order, one per line. Then read history.txt. Reply only FILEOK.")
        assert answer=="FILEOK",answer
        assert (r.work/"history.txt").read_text().splitlines()==markers
        r.command("compact",customInstructions="Preserve both HIST markers and the created history.txt path. Discard repetitive filler.")
        files=list(r.sessions.glob("*.jsonl"))
        entries=[json.loads(line) for f in files for line in f.read_text().splitlines()]
        compactions=[e for e in entries if e.get("type")=="compaction"]
        assert compactions,"no compaction persisted"
        summary=compactions[-1]["summary"]
        assert "CODEX_LATEST_USER_PROMPT_JSON" not in summary,"appendix leak"
        kept_index=next(i for i,e in enumerate(entries) if e.get("id")==compactions[-1]["firstKeptEntryId"])
        retained=json.dumps(entries[kept_index:])
        assert all(marker in summary or marker in retained for marker in markers),"lost markers from summary and retained context"
        answer=r.prompt("Without tools, recall the two unique HIST markers I gave you, in order, separated by one space. Reply only those.")
        assert answer==" ".join(markers),answer
        stats=r.stats()
        assert "compaction-summary route=compaction" in stats["routes"],"history summary route missing"
        assert "turn-prefix-summary route=compaction" in stats["routes"],"split prefix summary route missing"
        return {"summaryChars":len(summary),"multiTurnRecall":True,"appendixAbsent":True,"bothSummaryKinds":True,**stats}
    finally:r.close()
run("multiturn-compact",compact_case)
def concurrent_actor(index):
    r=RPC("concurrent-"+str(index))
    marker="ACTOR"+str(index)+uuid.uuid4().hex[:8].upper()
    try:
        assert r.prompt("Remember "+marker+". Use shell_command to append exactly one line '"+marker+"' to actor.txt. Read it back, then reply only ACTOROK.")=="ACTOROK"
        answer=r.prompt("What unique ACTOR marker did I give you? No tools, reply only that marker.")
        assert answer==marker,answer
        assert (r.work/"actor.txt").read_text().splitlines()==[marker],"duplicate side effect"
        return {"actor":index,"recall":True,"singleWrite":True,**r.stats()}
    finally:r.close()
def concurrent_case():
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        actors=list(executor.map(concurrent_actor,[1,2]))
    return {"actors":actors}
run("concurrent",concurrent_case)
def abort_case():
    r=RPC("abort-tool")
    try:
        r.command("prompt",message="Use shell_command to run exactly 'sleep 15; printf AFTER > after-abort.txt' in the current directory. After it finishes reply only FINISHED.")
        r.wait(lambda e:e.get("type")=="tool_execution_start" and e.get("toolName")=="shell_command")
        abort_start=len(r.records)
        ident=r.send("abort")
        r.wait(lambda e:e.get("type")=="response" and e.get("id")==ident,allow_errors=True)
        if not any(e.get("type")=="agent_settled" for e in r.records[abort_start:]):
            r.wait(lambda e:e.get("type")=="agent_settled",timeout=45,allow_errors=True)
        assert not (r.work/"after-abort.txt").exists(),"aborted command continued side effects"
        answer=r.prompt("Use shell_command to write exactly RECOVERED to recovery.txt. Reply only RECOVERED.")
        assert answer=="RECOVERED",answer
        assert (r.work/"recovery.txt").read_text()=="RECOVERED"
        return {"abortPreventedLateWrite":True,"sameSessionRecovery":True,**r.stats()}
    finally:r.close()
run("abort-tool",abort_case)
def installed_status():
    r=RPC("installed-status",default=True)
    try:
        data=r.command("get_commands")
        names=[e["name"] for e in data.get("commands",[])]
        assert all(n in names for n in ["review","review-status","chatgpt-web-status"]),names
        before=len(r.records)
        r.command("prompt",message="/chatgpt-web-status")
        r.command("prompt",message="/review-status")
        notices=[e.get("message") for e in r.records[before:] if e.get("type")=="extension_ui_request" and e.get("method")=="notify"]
        assert any("ready" in str(n).lower() and "ChatGPT Web bridge" in str(n) for n in notices),notices
        assert any(json.loads(n).get("readiness")=="READY" and not json.loads(n).get("blockers") for n in notices if n.startswith("{")),notices
        assert r.prompt("Reply only ALLPACKAGESOK. No tools.")=="ALLPACKAGESOK"
        return {"commandsLoaded":True,"bridgeReady":True,"reviewReady":True,**r.stats()}
    finally:r.close()
run("installed-status",installed_status)

def image_case():
    import base64,struct,zlib,binascii
    r=RPC("image")
    def chunk(kind,data):
        return struct.pack(">I",len(data))+kind+data+struct.pack(">I",binascii.crc32(kind+data)&0xffffffff)
    scan=b"".join(b"\x00"+b"\xff\x00\x00"*256+b"\x00\x00\xff"*256 for _ in range(256))
    png=b"\x89PNG\r\n\x1a\n"+chunk(b"IHDR",struct.pack(">IIBBBBB",512,256,8,2,0,0,0))+chunk(b"IDAT",zlib.compress(scan))+chunk(b"IEND",b"")
    try:
        r.command("prompt",message="Inspect this image. Name the dominant color of its left half and right half, in that order. Reply with exactly the two uppercase color names separated by one space. No tools.",
                  images=[{"type":"image","mimeType":"image/png","data":base64.b64encode(png).decode()}])
        r.wait(lambda e:e.get("type")=="agent_settled")
        text=r.command("get_last_assistant_text").get("text")
        assert text=="RED BLUE",text
        return {"imageInputVerified":True,"fixture":"512x256 RGB PNG, two color halves",**r.stats()}
    finally:r.close()
run("image",image_case)
def queued_case():
    r=RPC("queued-follow-up")
    try:
        r.command("prompt",message="Use shell_command to run 'sleep 3; printf FIRST > first.txt'. Reply only FIRSTOK.")
        r.wait(lambda e:e.get("type")=="tool_execution_start" and e.get("toolName")=="shell_command")
        queued_start=len(r.records)
        r.command("follow_up",message="After the current turn finishes, use shell_command to write exactly SECOND to second.txt and verify first.txt contains FIRST. Reply only SECONDOK.")
        if not any(e.get("type")=="agent_settled" for e in r.records[queued_start:]):
            r.wait(lambda e:e.get("type")=="agent_settled")
        assert (r.work/"first.txt").read_text()=="FIRST"
        assert (r.work/"second.txt").read_text()=="SECOND"
        assert r.command("get_last_assistant_text").get("text")=="SECONDOK"
        return {"queuedFollowUpCompleted":True,"orderedSideEffects":True,**r.stats()}
    finally:r.close()
run("queued-follow-up",queued_case)

report={"pass":all(r["pass"] for r in reports),"cases":reports,"baselineHealth":baseline,"finalHealth":health(),"extension":str(args.extension),"at":time.time()}
(ROOT/"report.json").write_text(json.dumps(report,indent=2))
print(json.dumps(report),flush=True)
raise SystemExit(0 if report["pass"] else 1)
