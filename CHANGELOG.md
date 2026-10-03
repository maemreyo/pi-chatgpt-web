# Changelog

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
