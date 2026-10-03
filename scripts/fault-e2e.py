"""Fault matrix through installed provider and real Pi retries; no ChatGPT requests."""
import argparse,http.server,json,os,pathlib,subprocess,threading,time
p=argparse.ArgumentParser()
p.add_argument("--output",required=True,type=pathlib.Path)
p.add_argument("--extension",default=str(pathlib.Path.home()/".pi/agent/git/github.com/maemreyo/pi-chatgpt-web/extensions/chatgpt-web.js"))
a=p.parse_args();a.extension=str(pathlib.Path(a.extension).resolve());root=a.output.resolve();root.mkdir(exist_ok=False,parents=True)
cases=[
("multipart",502,"upstream_server_error","ChatGPT browser stage timed out: multipart_stage_3_acknowledgement","json"),
("submitted",502,"chatgpt_submitted_turn_failed","ChatGPT stopped responding after the task started","json"),
("tool-wait",502,"codex_tool_timeout","codex_tool_timeout waiting for tool results","json"),
("inconsistent",502,"browser_stream_inconsistent","browser_stream_inconsistent state","json"),
("protocol",502,"multipart_protocol_violation","multipart_protocol_violation state","json"),
("stopped",502,"chatgpt_stopped_thinking","chatgpt_stopped_thinking","json"),
("generic-502",502,"upstream_server_error","ChatGPT browser request failed after submitting","json"),
("generic-timeout",504,"upstream_timeout","ChatGPT browser request timed out","json"),
("closed-before-headers",200,"","","close"),
("truncated-sse",200,"","","truncated"),
("partial-disconnect",200,"","","partial"),
("auth-expired",401,"chatgpt_session_expired","Sign in required","json"),
("invalid-input",400,"invalid_request","Malformed request","json"),
("rate-limit",429,"rate_limit_exceeded","Rate limit reached","json"),
]
reports=[]
for name,status,code,detail,kind in cases:
    requests=[]
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            payload=json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append({"model":payload.get("model"),"metadata":json.loads(payload.get("client_metadata",{}).get("x-codex-turn-metadata","{}"))})
            if kind=="close":self.close_connection=True;self.connection.shutdown(2);self.connection.close();return
            if kind in ("truncated","partial"):
                frames=[{"type":"response.created","response":{"id":"resp_fixture","status":"in_progress","model":"gpt-5.6-sol-instant","output":[]}}]
                if kind=="partial":frames += [
                    {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_fixture","role":"assistant","status":"in_progress","content":[]}},
                    {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}},
                    {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"PARTIAL"}]
                body="".join("event: "+f["type"]+"\ndata: "+json.dumps(f)+"\n\n" for f in frames).encode()
                self.send_response(200);self.send_header("Content-Type","text/event-stream")
            else:
                body=json.dumps({"error":{"type":"server_error" if status>=500 else "request_error","code":code,"message":detail,"retryable":False}}).encode()
                self.send_response(status);self.send_header("Content-Type","application/json")
            self.send_header("Content-Length",str(len(body)));self.end_headers();self.wfile.write(body)
        def log_message(self,*unused):pass
    server=http.server.ThreadingHTTPServer(("127.0.0.1",0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    agent=root/name;agent.mkdir()
    (agent/"settings.json").write_text(json.dumps({"retry":{"enabled":True,"maxRetries":3,"baseDelayMs":25},"compaction":{"enabled":False}}))
    env=os.environ.copy();env["PI_CODING_AGENT_DIR"]=str(agent);env["PI_CHATGPT_WEB_BASE_URL"]="http://127.0.0.1:"+str(server.server_port)+"/v1"
    try:
        result=subprocess.run(["pi","--offline","--mode","json","--no-session","--no-context-files","--no-extensions","--extension",a.extension,"--provider","chatgpt-web","--model","gpt-5.6-sol-instant","--thinking","off","-p","Reply only OK."],cwd=root,env=env,text=True,capture_output=True,timeout=50)
        events=[]
        for line in result.stdout.splitlines():
            try:events.append(json.loads(line))
            except ValueError:pass
        errors=[e["message"] for e in events if e.get("type")=="message_end" and e.get("message",{}).get("stopReason")=="error"]
        retries=[e for e in events if e.get("type")=="auto_retry_start"]
        report={"case":name,"pass":len(requests)==1 and bool(errors) and not retries,"requests":len(requests),"retryEvents":len(retries),"error":errors[-1].get("errorMessage") if errors else None,"exitCode":result.returncode}
        reports.append(report);print(json.dumps(report),flush=True)
        (root/(name+"-events.json")).write_text(json.dumps(events,indent=2))
        (root/(name+"-stderr.log")).write_text(result.stderr)
    except Exception as error:
        reports.append({"case":name,"pass":False,"error":str(error)})
    finally:server.shutdown();server.server_close();thread.join(timeout=2)
report={"pass":all(r["pass"] for r in reports),"cases":reports,"at":time.time(),"extension":a.extension}
(root/"report.json").write_text(json.dumps(report,indent=2))
raise SystemExit(0 if report["pass"] else 1)
