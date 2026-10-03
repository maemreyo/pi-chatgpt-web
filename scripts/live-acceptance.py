"""Run isolated Pi RPC acceptance against the existing bridge; never restart shared runtimes."""
import argparse
import json
import os
import pathlib
import selectors
import subprocess
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=["manual", "auto", "native"])
parser.add_argument("--extension", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1] / "extensions/chatgpt-web.js")
parser.add_argument("--output", type=pathlib.Path, required=True)
args = parser.parse_args()
root = args.output.resolve()
root.mkdir(parents=True, exist_ok=False)
agent, sessions, work = (root / n for n in ["agent", "sessions", "work"])
for directory in [agent, sessions, work]:
    directory.mkdir()
(agent / "settings.json").write_text(json.dumps({
    "compaction": {"enabled": args.mode == "auto", "reserveTokens": 88000 if args.mode == "auto" else 16384, "keepRecentTokens": 0},
    "retry": {"enabled": True, "maxRetries": 2, "baseDelayMs": 100},
}))
env = os.environ.copy()
env["PI_CODING_AGENT_DIR"] = str(agent)
env["PI_CHATGPT_WEB_DEBUG"] = "1"
cmd = ["pi", "--mode", "rpc", "--no-extensions", "--extension", str(args.extension.resolve()),
       "--provider", "chatgpt-web", "--model", "gpt-5.6-sol", "--thinking", "medium", "--session-dir", str(sessions)]
process = subprocess.Popen(cmd, cwd=work, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           text=True, bufsize=1)
selector = selectors.DefaultSelector()
selector.register(process.stdout, selectors.EVENT_READ, "out")
selector.register(process.stderr, selectors.EVENT_READ, "err")
records, errors = [], []
report = {"mode": args.mode, "extension": str(args.extension.resolve()), "startedAt": time.time(), "pass": False}
marker = "MARKER" + uuid.uuid4().hex[:12].upper()

def send(value):
    process.stdin.write(json.dumps(value) + "\n")
    process.stdin.flush()

def wait(predicate, timeout=360):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for key, _ in selector.select(timeout=0.25):
            line = key.fileobj.readline()
            if not line:
                selector.unregister(key.fileobj)
                continue
            if key.data == "err":
                errors.append(line.rstrip())
                continue
            try:
                value = json.loads(line)
            except ValueError:
                errors.append("NONJSON:" + line.rstrip())
                continue
            records.append(value)
            if value.get("type") == "turn_end" and value.get("message", {}).get("stopReason") == "error":
                raise RuntimeError(value["message"].get("errorMessage", "provider failure"))
            if value.get("type") == "compaction_end" and (value.get("aborted") or value.get("errorMessage")):
                raise RuntimeError(str(value))
            if predicate(value):
                return value
        if process.poll() is not None:
            raise RuntimeError("Pi exited: " + str(process.returncode))
    raise TimeoutError("RPC event was not observed")

def text(message):
    return "".join(block.get("text", "") for block in message.get("content", []) if block.get("type") == "text")

try:
    if args.mode in ["manual", "auto"]:
        prompt = "Remember this unique marker: " + marker + ". Do not use tools. Reply only SEEDOK. The following filler has no task meaning:\n" + "alpha beta gamma delta epsilon " * 650
        send({"id": "seed", "type": "prompt", "message": prompt})
        wait(lambda e: e.get("type") == "agent_settled" if args.mode == "manual"
             else e.get("type") == "compaction_end" and e.get("reason") == "threshold")
        if args.mode == "auto":
            wait(lambda e: e.get("type") == "agent_settled")
        if args.mode == "manual":
            send({"id": "compact", "type": "compact", "customInstructions": "Preserve the unique marker from the initial request and discard repetitive filler."})
            response = wait(lambda e: e.get("type") == "response" and e.get("id") == "compact")
            assert response.get("success"), response
        send({"id": "recall", "type": "prompt", "message": "What unique marker did I ask you to remember? Reply only that marker, with no tools."})
        wait(lambda e: e.get("type") == "response" and e.get("id") == "recall")
        wait(lambda e: e.get("type") == "agent_settled")
        entries = [json.loads(line) for file in sessions.glob("*.jsonl") for line in file.read_text().splitlines()]
        compact = next(e for e in entries if e.get("type") == "compaction")
        summary = compact["summary"]
        turns = [e["message"] for e in records if e.get("type") == "turn_end" and e.get("message", {}).get("role") == "assistant"]
        before, after = turns[0]["usage"]["input"], turns[-1]["usage"]["input"]
        assert "CODEX_LATEST_USER_PROMPT_JSON" not in summary, "canonical appendix leaked into summary"
        assert marker in summary, "summary lost marker"
        assert marker == text(turns[-1]).strip(), "post-compaction recall failed"
        assert after < before, "compaction did not reduce request input"
        report.update(summaryChars=len(summary), inputBefore=before, inputAfter=after,
                      reductionTokens=before-after, recall=True, canonicalAppendixAbsent=True,
                      model=turns[-1]["model"], thinking=turns[-1].get("thinkingLevel"))
    else:
        quoted = work / "it's here"
        quoted.mkdir()
        bad = work / "missing"
        prompt = ("Use shell_command (Codex Native command execution) for both commands. "
                  "First run the exact command 'printf FIRST; printf BAD > should-not-exist.txt' with workdir "
                  + str(bad) + ". That directory does not exist; the command must fail and create no file. "
                  "Then run a multiline shell script in workdir " + str(quoted)
                  + " that writes exactly native-bridge-ok followed by a newline to result.txt and verifies it. "
                  "Do not create the missing directory. Finally reply only NATIVEOK.")
        send({"id": "native", "type": "prompt", "message": prompt})
        wait(lambda e: e.get("type") == "agent_settled")
        starts = [e for e in records if e.get("type") == "tool_execution_start" and e.get("toolName") == "shell_command"]
        failed = [e for e in records if e.get("type") == "tool_execution_end" and e.get("toolName") == "shell_command" and e.get("isError")]
        assert any(e.get("args", {}).get("workdir") == str(bad) for e in starts), "invalid workdir not exercised"
        assert failed, "invalid workdir was not reported as a tool error"
        assert not list(work.rglob("should-not-exist.txt")), "command ran after cd failure"
        assert (quoted / "result.txt").read_bytes() == b"native-bridge-ok\n", "native output mismatch"
        report.update(nativeCommandCalls=len(starts), failedWorkdirCalls=len(failed), noWrongDirectoryWrite=True, quotedWorkdir=True)
    report["pass"] = True
except Exception as error:
    report["error"] = str(error)
finally:
    # This process owns only these isolated RPC sessions. Shared Pi/Workbench/bridge are untouched.
    try:
        send({"type": "abort"})
    except (BrokenPipeError, OSError):
        pass
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    report["finishedAt"] = time.time()
    (root / "rpc-records.json").write_text(json.dumps(records, ensure_ascii=False, indent=2))
    (root / "stderr.log").write_text("\n".join(errors))
    (root / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)
raise SystemExit(0 if report["pass"] else 1)
