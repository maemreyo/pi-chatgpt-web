# pi-chatgpt-web

Use the ChatGPT Web models exposed by [`miuuyy/codex-chatgpt-web`](https://github.com/miuuyy/codex-chatgpt-web) as a native provider in [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

This package bridges Pi's OpenAI Responses provider to the local `codex-chatgpt-web` Responses endpoint and adds the Codex turn metadata required by current `codex-chatgpt-web` releases.

## Status

Tested with:

- Pi `@mariozechner/pi-coding-agent` 0.66.1
- `codex-chatgpt-web` 6.1.4
- ChatGPT Plus
- GPT-5.6 Sol Instant
- GPT-5.6 Sol Medium
- GPT-5.6 Sol High

## Prerequisites

1. Install and configure `codex-chatgpt-web`.
2. Sign in to ChatGPT in its launcher.
3. Run its browser smoke test successfully.
4. Keep the launcher/runtime running. The default local endpoint is `http://127.0.0.1:17841/v1`.
5. Install Pi.

For local filesystem/shell/tool access, configure the **Full** harness in `codex-chatgpt-web`. Browser-only mode can run the Web model but intentionally has no outer local tools.

## Install

From GitHub:

```bash
pi install git:github.com/maemreyo/pi-chatgpt-web
```

During development from a local checkout:

```bash
pi install /path/to/pi-chatgpt-web
```

## Use

Instant:

```bash
pi --provider chatgpt-web --model gpt-5.6-sol-instant
```

Medium:

```bash
pi --provider chatgpt-web --model gpt-5.6-sol --thinking medium
```

High:

```bash
pi --provider chatgpt-web --model gpt-5.6-sol --thinking high
```

Inside Pi you can also select the provider/model through the model picker.

## Configuration

By default the package connects to:

```text
http://127.0.0.1:17841/v1
```

Override it with:

```bash
export PI_CHATGPT_WEB_BASE_URL=http://127.0.0.1:17841/v1
```

`PI_CHATGPT_WEB_API_KEY` may be set if you place another local gateway in front of the bridge. For the stock loopback `codex-chatgpt-web` Web route, the default local bearer value is sufficient; ChatGPT authentication stays in the `codex-chatgpt-web` launcher/browser profile.

## What the extension does

Pi already supports the OpenAI Responses wire format. The remaining compatibility gap is lifecycle metadata: current `codex-chatgpt-web` requires a task/thread identity, a turn identity, and provenance on the current user message. This extension injects those fields immediately before Pi sends each provider request and rewrites the public Pi model ID to the `chatgpt-web/...` route expected by the bridge.

It does **not** read, copy, or store your ChatGPT cookies, browser state, OpenAI API keys, or `codex-chatgpt-web` tunnel credentials.

## Limits and safety

- This is an unofficial integration and is not affiliated with or endorsed by OpenAI, Pi, or `codex-chatgpt-web`.
- It does not bypass authentication or usage limits. Requests use the ChatGPT Web account already signed in through `codex-chatgpt-web` and are subject to that account's limits and applicable terms.
- `codex-chatgpt-web` can break when ChatGPT's Web UI changes. Keep it updated and use its smoke test/diagnostics.
- Full harness mode grants the selected Web model access to local tools through the harness. Review the upstream security model and use trusted workspaces.

## Development

```bash
npm test
npm run check
```

A quick inference smoke test, with `codex-chatgpt-web` already running:

```bash
pi --extension ./extensions/chatgpt-web.js \
  --provider chatgpt-web \
  --model gpt-5.6-sol-instant \
  --no-tools --no-session -p 'Reply exactly PI_WEB_OK'
```

## License

MIT
