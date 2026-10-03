# Changelog

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
