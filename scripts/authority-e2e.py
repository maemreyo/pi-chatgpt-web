"""Real Pi authority E2E with adversarial local Responses tool calls; never reaches ChatGPT."""
import argparse,http.server,json,os,pathlib,subprocess,threading
p=argparse.ArgumentParser();p.add_argument("--output",type=pathlib.Path,required=True);p.add_argument("--extension",default=str(pathlib.Path.home()/".pi/agent/git/github.com/maemreyo/pi-chatgpt-web/extensions/chatgpt-web.js"))
a=p.parse_args();a.extension=str(pathlib.Path(a.extension).resolve());root=a.output.resolve();root.mkdir(parents=True,exist_ok=False);reports=[]
for name in ["no-bash","nested-hook-block"]:
    work=root/name;work.mkdir();requests=[];sentinel=work/"must-not-exist.txt"
    def frame(v):return "event: "+v["type"]+"\ndata: "+json.dumps(v)+"\n\n"
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            payload=json.loads(self.rfile.read(int(self.headers["Content-Length"])));requests.append(payload)
            response={"id":"resp_"+str(len(requests)),"model":"gpt-5.6-sol-instant","status":"in_progress","output":[]}
            events=[{"type":"response.created","response":response.copy()}]
            if len(requests)==1:
                item={"type":"function_call","id":"fc_authority","call_id":"call_authority","name":"shell_command","arguments":json.dumps({"command":"printf BAD > "+str(sentinel),"workdir":str(work),"timeout_ms":1000})}
                events += [{"type":"response.output_item.added","output_index":0,"item":{**item,"arguments":""}},
                           {"type":"response.function_call_arguments.delta","output_index":0,"delta":item["arguments"]},
                           {"type":"response.function_call_arguments.done","output_index":0,"arguments":item["arguments"]},
                           {"type":"response.output_item.done","output_index":0,"item":item}]
            else:
                item={"type":"message","id":"msg_authority","role":"assistant","status":"completed","content":[{"type":"output_text","text":"BLOCKEDOK","annotations":[]}]}
                events += [{"type":"response.output_item.added","output_index":0,"item":{**item,"content":[]}},
                           {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}},
                           {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"BLOCKEDOK"},
                           {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"BLOCKEDOK"},
                           {"type":"response.output_item.done","output_index":0,"item":item}]
            response.update(status="completed",output=[item],usage={"input_tokens":12,"output_tokens":8,"total_tokens":20})
            events.append({"type":"response.completed","response":response})
            body="".join(frame(e) for e in events).encode()
            self.send_response(200);self.send_header("Content-Type","text/event-stream");self.send_header("Content-Length",str(len(body)));self.end_headers();self.wfile.write(body)
        def log_message(self,*unused):pass
    server=http.server.ThreadingHTTPServer(("127.0.0.1",0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    agent=work/"agent";agent.mkdir();(agent/"settings.json").write_text(json.dumps({"compaction":{"enabled":False},"retry":{"enabled":True,"maxRetries":2,"baseDelayMs":25}}))
    env=os.environ.copy();env["PI_CODING_AGENT_DIR"]=str(agent);env["PI_CHATGPT_WEB_BASE_URL"]="http://127.0.0.1:"+str(server.server_port)+"/v1"
    cmd=["pi","--offline","--mode","json","--no-session","--no-context-files","--no-extensions","--extension",a.extension,"--provider","chatgpt-web","--model","gpt-5.6-sol-instant","--thinking","off"]
    if name=="no-bash":cmd+=["--no-builtin-tools","--tools","shell_command"]
    else:
        policy=work/"block.js"
        policy.write_text('export default pi => { pi.on("tool_call", event => { if(event.toolName === "bash") { console.error("STRESS_NESTED_BLOCK "+JSON.stringify({nested:!!event.parentToolCallId})); return {block:true,reason:"STRESS_POLICY_DENIED"}; } }); };')
        cmd+=["--extension",str(policy)]
    try:
        result=subprocess.run(cmd+["-p","Perform the requested fixture operation."],cwd=work,env=env,text=True,capture_output=True,timeout=40)
        events=[]
        for line in result.stdout.splitlines():
            try:events.append(json.loads(line))
            except ValueError:pass
        results=[e for e in events if e.get("type")=="tool_execution_end"]
        toolresults=[e["message"] for e in events if e.get("type")=="message_end" and e.get("message",{}).get("role")=="toolResult"]
        declarations=[t.get("name") or t.get("function",{}).get("name") for t in requests[0].get("tools",[])] if requests else []
        blocked=any(m.get("isError") for m in toolresults)
        if name=="no-bash":authority_ok="bash" not in declarations and "shell_command" not in declarations
        else:authority_ok='"nested":true' in result.stderr and "STRESS_POLICY_DENIED" in json.dumps(toolresults)
        report={"case":name,"pass":len(requests)==2 and blocked and authority_ok and not sentinel.exists(),"requests":len(requests),"toolErrorObserved":blocked,"noSideEffects":not sentinel.exists(),"authorityVerified":authority_ok,"exitCode":result.returncode}
        reports.append(report);print(json.dumps(report),flush=True)
        (work/"events.json").write_text(json.dumps(events,indent=2));(work/"stderr.log").write_text(result.stderr)
    except Exception as e:reports.append({"case":name,"pass":False,"error":str(e)})
    finally:server.shutdown();server.server_close();thread.join(timeout=2)
report={"pass":all(r["pass"] for r in reports),"cases":reports};(root/"report.json").write_text(json.dumps(report,indent=2))
raise SystemExit(0 if report["pass"] else 1)
