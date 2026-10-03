"""Verify actual Pi + SDK retry behavior against a local failure fixture, without sending to ChatGPT."""
import argparse
import http.server
import json
import os
import pathlib
import subprocess
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument("--extension", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1] / "extensions/chatgpt-web.js")
parser.add_argument("--output", type=pathlib.Path, required=True)
args = parser.parse_args()
root = args.output.resolve()
root.mkdir(parents=True, exist_ok=False)
reports = []
failures = {
    "multipart": ("upstream_server_error", "ChatGPT browser stage timed out: multipart_stage_5_acknowledgement"),
    "submitted": ("chatgpt_submitted_turn_failed", "ChatGPT stopped responding after the task started"),
    "truncated": ("fixture_truncated_stream", "response stream has no terminal event"),
}
for name, (code, detail) in failures.items():
    requests = []
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append({"path": self.path, "model": data.get("model")})
            if name == "truncated":
                body = ('event: response.created\ndata: ' + json.dumps({"type": "response.created", "response": {"id": "resp_fixture", "status": "in_progress", "model": "gpt-5.6-sol-instant", "output": []}}) + '\n\n').encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
            else:
                body = json.dumps({"error": {"type": "server_error", "code": code, "message": detail, "retryable": False}}).encode()
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *unused):
            pass
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    agent = root / name
    agent.mkdir()
    (agent / "settings.json").write_text(json.dumps({"retry": {"enabled": True, "maxRetries": 3, "baseDelayMs": 50}, "compaction": {"enabled": False}}))
    env = os.environ.copy()
    env["PI_CODING_AGENT_DIR"] = str(agent)
    env["PI_CHATGPT_WEB_BASE_URL"] = "http://127.0.0.1:" + str(server.server_port) + "/v1"
    try:
        command = ["pi", "--mode", "json", "--no-session", "--no-extensions", "--extension", str(args.extension.resolve()),
                   "--provider", "chatgpt-web", "--model", "gpt-5.6-sol-instant", "--thinking", "off", "-p", "Reply only OK."]
        result = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True, timeout=40)
        events = []
        for line in result.stdout.splitlines():
            try: events.append(json.loads(line))
            except ValueError: pass
        messages = [e["message"] for e in events if e.get("type") == "message_end" and e.get("message", {}).get("stopReason") == "error"]
        retries = [e for e in events if e.get("type") in ["auto_retry_start", "auto_retry_end"]]
        passed = len(requests) == 1 and bool(messages) and not retries and "automatic replay is disabled" in messages[-1].get("errorMessage", "")
        reports.append({"case": name, "pass": passed, "httpRequestCount": len(requests), "retryEventCount": len(retries),
                        "requestRoutes": requests, "errorMessage": messages[-1].get("errorMessage") if messages else None})
        (root / (name + "-events.json")).write_text(json.dumps(events, indent=2))
        (root / (name + "-stderr.log")).write_text(result.stderr)
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
report = {"pass": all(r["pass"] for r in reports), "cases": reports, "at": time.time(), "transport": "local injected HTTP 502 and truncated SSE; actual Pi CLI with retry enabled"}
(root / "report.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report))
raise SystemExit(0 if report["pass"] else 1)
