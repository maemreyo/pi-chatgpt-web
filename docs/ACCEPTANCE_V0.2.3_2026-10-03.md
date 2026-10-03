# Pi ChatGPT Web v0.2.3 acceptance — 2026-10-03

The release fixes the complete-script workdir guard, excludes the verified Codex latest-prompt appendix from Pi summaries, and prevents automatic replay of known post-submission or interrupted-stream failures. Original failures remain visible through /chatgpt-web-status in the same process.

## Verified

| Check | Observed result |
| --- | --- |
| Regression suite | 32/32 PASS, zero skips |
| Package dry run and diff whitespace | PASS |
| Manual compaction, Sol Medium | Summary 935 characters; request input 13,285 → 10,290 tokens |
| Threshold auto-compaction, Sol Medium | Summary 763 characters; request input 13,282 → 10,254 tokens |
| Recall after compaction | Both returned a unique marker without repeating the answer in the follow-up prompt |
| Native command, Sol Medium | Two shell_command calls; bad workdir reported an error and created no fallback file; quoted workdir produced verified exact output |
| Actual Pi retry policy against local HTTP 502/SSE fixture | Multipart, submitted-turn and truncated-stream cases each made one request and emitted zero retry events |
| Bridge staging observation | Checkpoints 1–5 acknowledged and completed during compaction acceptance |

Machine-readable results and extension hashes are in [acceptance-v0.2.3.json](evidence/acceptance-v0.2.3.json). Reproduction scripts are in scripts/live-acceptance.py and scripts/retry-acceptance.py. They use separate temporary Pi agent/session directories and leave shared Pi, Workbench and bridge processes running.

The final error guards additionally cover generic connection loss after response start, stopped-thinking responses and missing tool results. The complete regression suite and actual CLI retry fixture passed after those guards were added. Live model success paths were exercised on Sol Medium; other model/effort paths are not newly claimed by this report.

## Limits

The adapter cannot guarantee that an external ChatGPT response will never stall. It does not alter bridge deadlines, restart the browser, or blindly resend a possibly accepted task. A known ambiguous failure requires inspecting the ChatGPT tab before deciding how to continue. Bridge health alone does not establish the outcome of an earlier failed turn.

Summary usage remains the actual upstream usage, including any tokens spent generating the bridge appendix. Removing that appendix lowers the next request's context; it does not undo generation usage already incurred. Previous saved summaries are not rewritten.
