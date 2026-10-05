# Changelog

## 0.2.5 - 2026-10-05

- Add a bridge-aware context-budget resolver for `codex-chatgpt-web` 6.1.4. Keep raw bridge context, Pi-advertised usable context, and the safe compaction threshold distinct instead of blindly advertising Bigger Context's raw window.
- For ChatGPT Plus Sol Medium/High with Bigger Context enabled, derive `270000` raw / `256384` Pi usable / `240000` safe-threshold tokens so Pi's default `16384` reserve compacts no later than the bridge. Low/Instant and supported Pro variants use their own 6.1.4 bounds.
- Refresh provider/model metadata on session start, idle input before pre-turn compaction, before agent turns, thinking-level changes, model selection, and status checks. Rebind the active Pi model through public APIs so a disabled experiment or lower effort cannot leave a stale larger model object active.
- Fail closed when health/config provenance is missing, malformed, version-mismatched, unsupported, or remote/custom. The exact default loopback bridge may use only a bounded, whitelisted, version-matched local config snapshot; custom/remote bridge URLs never inherit local-default capabilities.
- Extend `/chatgpt-web-status` with budget provenance, raw bridge window, Pi usable window, bridge auto-compact limit, and effective safe compaction threshold. Read effective global/project/model compaction policy through public pi.getSettings(); account for smaller reserves, preserve stricter reserves and disabled auto-compaction, and never write Pi settings. Bound metadata refresh and explain fallback causes.
- Add deterministic mocked regression coverage for Plus x3/base budgets, Low/Instant/Pro variants, local provenance checks, remote isolation, malformed metadata, status formatting, and active-model shrink/refresh behavior.

## 0.2.4 - 2026-10-03

- Prevent Pi from replaying ambiguous generic 502/504, rate-limit and transport failures; retain original diagnostics and explicit connection-refused retry behavior. Caller abort takes precedence over transport errors.
- Preserve user message IDs when instructions move into history, fixing same-session recovery after abort and keeping tool/resume lineage stable.
- Inherit supported thinking effort for Sol control summaries, fixing branch summaries that otherwise requested unsupported effort none.
- Add reproducible deep E2E scripts for model/tool/resume, summary paths, concurrent isolation, cancellation, queued follow-up, image input, Firefox and review integration, injected HTTP/SSE faults, and nested tool authority.

## 0.2.3 - 2026-10-03

- Stop the complete shell script if its requested working directory cannot be entered, including semicolon, multiline, and asynchronous command lists. Keep quoted paths and the script's exit status intact.
- Remove the bridge's canonical latest-user-prompt appendix from Pi summaries only when its JSON string exactly matches the current summary request. Buffer summary events so the appendix cannot leak through streaming deltas or the stored result; preserve ordinary replies, reasoning, cancellation, and actual usage accounting.
- Disable SDK-level HTTP replay. Prevent Pi's text-based retry policy from automatically replaying known browser post-submission failures, multipart acknowledgement failures, stopped-thinking responses, missing tool results, and incomplete terminal streams. Preserve original diagnostics in /chatgpt-web-status for the current process.
- Add executable shell regressions, summary/event-frame coverage, retry-classifier coverage, and reproducible isolated Pi acceptance scripts.

## 0.2.2 - 2026-10-03

- Route Pi manual compaction, threshold auto-compaction, split-turn prefix summaries, and branch summaries through the ChatGPT Web provider instead of falling through to native Codex authentication. Summary turns are intentionally tool-less and carry explicit compaction metadata.
- Keep compaction retry identities stable, isolate control-turn identities from ordinary agent turns, and prevent the local placeholder bearer from leaking into native Codex routing.
- E2E-verify both manual and threshold auto-compaction through `codex-chatgpt-web` 6.1.4, including multipart staging acknowledgements and a successful post-compaction continuation.
- Add a `shell_command` compatibility tool for ChatGPT Web turns so `codex-chatgpt-web` can satisfy Codex Native command requests even when Pi names its built-in command tool `bash`.
- Delegate `shell_command` to Pi's real `bash` tool through `ctx.executeTool()`, preserving Pi validation, permission hooks, nested tool lifecycle, streaming updates, and error state instead of creating a separate shell authority.
- Activate the compatibility alias only for `chatgpt-web` turns where `bash` is active, and strip it defensively from outgoing requests when `bash` is unavailable.
- Add `/chatgpt-web-status`, backed by the bridge `/healthz` endpoint rather than the authenticated native `/v1/models` passthrough.
- Declare Pi-hosted runtime packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `typebox`) as `peerDependencies: "*"` per Pi package guidance, avoiding duplicate host runtime copies.
- Add regression coverage for provider routing, compaction, command argument mapping, activation/authority guards, nested error propagation, and bridge health reporting.

## 0.2.1 - 2026-10-03

- Align the host-provided `@earendil-works/pi-coding-agent` peer dependency with Pi package guidance by using the `"*"` range.
- Update install and troubleshooting examples to the current release tag.

## 0.2.0 - 2026-10-03

- Retarget the package to `earendil-works/pi` / `@earendil-works/pi-coding-agent` 1.0.0+.
- Verify GPT-5.6 Sol Instant, Medium, and High through the ChatGPT Web bridge.
- Verify a multi-round Full-harness tool loop with Pi local tools.
- Use UUID-format native thread/turn identifiers expected by current `codex-chatgpt-web`.
- Keep user and environment item IDs stable for the lifetime of an agent turn, fixing continuation failures after tool calls.
- Add trusted working-directory environment metadata required by current Full mode.
- Replace legacy Pi documentation and installation commands.

## 0.1.0 - 2026-10-03

- Initial experimental release.
- Targeted the legacy `@mariozechner/pi-coding-agent` package. This release is deprecated; use 0.2.0 or newer.
