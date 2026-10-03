# pi-chatgpt-web

Use ChatGPT Web models exposed by [`miuuyy/codex-chatgpt-web`](https://github.com/miuuyy/codex-chatgpt-web) as a native provider in [`earendil-works/pi`](https://github.com/earendil-works/pi).

`pi-chatgpt-web` keeps Pi as the agent/runtime and uses `codex-chatgpt-web` only as the local Responses bridge to the ChatGPT Web account already signed in through its launcher. No OpenAI API model billing is required for the Web-routed model calls; normal ChatGPT account usage limits still apply.

## Status

Current target:

- Pi: `@earendil-works/pi-coding-agent` **1.0.0+**
- `codex-chatgpt-web`: **6.1.4** tested
- ChatGPT Plus tested
- GPT-5.6 Sol Instant tested
- GPT-5.6 Sol Medium tested
- GPT-5.6 Sol High tested
- Full multi-round tool loop tested: ChatGPT Web → Responses tool call → Pi local tool execution → tool result → ChatGPT Web continuation
- Manual and threshold auto-compaction tested through ChatGPT Web, including multipart staging and post-compaction continuation

> **Version note:** `v0.1.0` targeted the older `@mariozechner/pi-coding-agent` package and is deprecated. Use `v0.2.2` or newer for `earendil-works/pi`.

## How it works

```text
Pi (earendil-works/pi)
    │
    │ OpenAI Responses protocol
    ▼
pi-chatgpt-web
    │  adds stable Codex-compatible thread/turn/item metadata
    ▼
127.0.0.1:17841/v1
    │
    ▼
codex-chatgpt-web
    │
    ▼
ChatGPT Web account
    │
    ├─ GPT-5.6 Sol Instant
    └─ GPT-5.6 Sol Medium / High
```

In Full harness mode, tool calls make the return trip:

```text
ChatGPT Web → Codex Native2 connector → codex-chatgpt-web bridge
            → Responses tool call → Pi tool → tool result → ChatGPT Web
```

Pi remains responsible for its local tool execution and normal tool hooks/validation.

## Prerequisites

### 1. Install the current Pi

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
```

Node.js 22.19 or newer is required by current Pi releases.

### 2. Configure `codex-chatgpt-web`

Install and configure [`miuuyy/codex-chatgpt-web`](https://github.com/miuuyy/codex-chatgpt-web), then:

1. Sign in to ChatGPT in the `Codex Web GPT` launcher.
2. Run its browser smoke test.
3. Keep the launcher/runtime running.

The default local Responses endpoint is:

```text
http://127.0.0.1:17841/v1
```

### 3. Choose the upstream mode

For model inference only, Browser-only mode is enough.

For Pi to use local tools through a ChatGPT Web turn, configure the **Full harness** in `codex-chatgpt-web` and complete its MCP setup. The upstream launcher currently expects the ChatGPT connector named `Codex Native2`; run **Verify runtime** after setup.

## Install this Pi package

From the tagged GitHub release:

```bash
pi install git:github.com/maemreyo/pi-chatgpt-web@v0.2.2
```

Or track the repository default branch:

```bash
pi install git:github.com/maemreyo/pi-chatgpt-web
```

For local development:

```bash
pi install /path/to/pi-chatgpt-web
```

Pi packages are the native distribution mechanism for shared extensions in current `earendil-works/pi`.

## Use

### Sol Instant

```bash
pi --provider chatgpt-web --model gpt-5.6-sol-instant
```

### Sol Medium

```bash
pi --provider chatgpt-web --model gpt-5.6-sol --thinking medium
```

### Sol High

```bash
pi --provider chatgpt-web --model gpt-5.6-sol --thinking high
```

You can also choose `chatgpt-web` models from Pi's model picker.

### Check bridge status

Inside Pi, run:

```text
/chatgpt-web-status
```

The command checks the bridge's unauthenticated `/healthz` endpoint derived from `PI_CHATGPT_WEB_BASE_URL` (or the default `http://127.0.0.1:17841/v1`). It reports whether the expected `codex-chatgpt-web` service is healthy and accepting turns, plus the bridge version and mode when available. It intentionally does not use `/v1/models`: that route is a native Codex passthrough and requires upstream ChatGPT Bearer authentication that this Pi extension does not own.

## Tool use

With `codex-chatgpt-web` Full harness configured, use Pi normally. Pi's active tools are advertised in the Responses request. When ChatGPT Web requests one through the Full harness connector, `codex-chatgpt-web` emits a Responses tool call back to Pi; Pi executes it and the extension keeps the same native turn identity across the continuation round.

Pi calls its built-in command tool `bash`, while current Codex Native command routing recognizes `exec_command` or `shell_command`. From `v0.2.2`, this extension exposes `shell_command` only on `chatgpt-web` turns when Pi's real `bash` tool is active. The alias delegates back through Pi's nested-tool API, so normal Pi tool validation, permission hooks, lifecycle events, streaming output, and error handling remain authoritative. It does not create command access when `bash` is disabled.

A minimal non-interactive test:

```bash
mkdir -p /tmp/pi-chatgpt-web-smoke
cd /tmp/pi-chatgpt-web-smoke
printf 'seed-value-42\n' > seed.txt

pi --provider chatgpt-web \
  --model gpt-5.6-sol \
  --thinking high \
  --no-session \
  -p 'Read seed.txt with local tools and create result.txt containing the same value.'
```

Browser-only mode can still use the Web model, but `codex-chatgpt-web` intentionally does not expose the local-computer bridge in that mode.

## Compaction and summaries

Pi's compaction and branch-summary calls are model requests too. From `v0.2.2`, the extension routes manual compaction, threshold auto-compaction, split-turn prefix summaries, and branch summaries through the same ChatGPT Web provider path as ordinary turns. Summary requests are intentionally tool-less: they do not receive filesystem/workspace authority, and their native metadata identifies them as compaction control turns.

This fixes the failure mode where normal ChatGPT Web turns worked but auto-compaction fell through to native Codex authentication and failed with an authentication-token/401 error. The compaction route also keeps retry identity stable and does not expose the local placeholder bearer to native Codex routing.

## Configuration

The default bridge endpoint is:

```text
http://127.0.0.1:17841/v1
```

Override it with:

```bash
export PI_CHATGPT_WEB_BASE_URL=http://127.0.0.1:17841/v1
```

If another local gateway in front of the bridge requires a bearer value:

```bash
export PI_CHATGPT_WEB_API_KEY=your-local-gateway-key
```

For the stock loopback Web route, the extension uses a non-secret local bearer placeholder. ChatGPT authentication remains in the `codex-chatgpt-web` launcher/browser profile.

## What the extension changes

Pi already supports the OpenAI Responses wire protocol. Current `codex-chatgpt-web` additionally expects native-Codex-style request provenance. The extension therefore:

- registers `chatgpt-web` as an `openai-responses` provider;
- maps Pi model IDs to the bridge's `chatgpt-web/...` routes;
- creates UUID-format thread and turn identities;
- keeps user/environment item IDs stable across all provider rounds of one Pi agent turn;
- attaches the current Pi working directory as trusted environment metadata for Full-mode tool rounds;
- preserves the same turn identity when Pi sends tool results back to the bridge.

Stable item IDs are important. Regenerating the current user message ID on a tool-result continuation causes `codex-chatgpt-web` to reject the earlier browser response as superseded.

## Security and privacy

The extension does **not** read, copy, or store:

- ChatGPT cookies;
- ChatGPT browser profile data;
- OpenAI API keys;
- `codex-chatgpt-web` tunnel runtime credentials.

It does send the current Pi working-directory path and Pi's active tool schemas to the local bridge because Full-mode tool routing requires that environment and tool context.

A Full harness gives ChatGPT Web a path to invoke the tools Pi advertises for the current turn. Pi still executes those tool calls locally, so Pi's tool validation, extension hooks, and any local isolation you configured remain relevant. Use trusted workspaces and review the upstream `codex-chatgpt-web` security model before enabling Full mode.

This is an unofficial integration and is not affiliated with or endorsed by OpenAI, `earendil-works/pi`, or `codex-chatgpt-web`. It does not bypass authentication or account usage limits.

## Troubleshooting

### `Connection refused` on `127.0.0.1:17841`

Start the `Codex Web GPT` launcher/runtime and confirm its local Responses proxy is healthy.

### `ChatGPT web requires native Codex turn_id metadata`

The extension is not loaded, or you are running an obsolete package version. Check:

```bash
pi list
pi --list-models chatgpt-web
```

### `A newer Codex instruction superseded this ChatGPT response`

Update to `pi-chatgpt-web` v0.2.2 or newer. Older builds before v0.2.0 regenerated message IDs across tool-result rounds; v0.2.2 also adds the Pi `bash` → Codex Native `shell_command` compatibility path.

### Auto-compaction fails with a native authentication / 401 error

Update to `pi-chatgpt-web` v0.2.2 or newer. Earlier builds only rewrote ordinary provider requests; Pi summary requests could bypass that hook and reach the wrong native-auth route.

### Local tools unavailable

`codex-chatgpt-web` is running in Browser-only mode. Complete the upstream Full harness/MCP setup and run **Verify runtime**.

### Model appears but the requested effort is unavailable

Model/effort eligibility comes from the ChatGPT account used by the launcher. The extension does not unlock account-gated models or thinking levels.

## Development

Run package tests:

```bash
npm test
npm run check
```

List models using the extension directly:

```bash
pi --extension ./extensions/chatgpt-web.js --list-models chatgpt-web
```

Inference smoke test:

```bash
pi --extension ./extensions/chatgpt-web.js \
  --provider chatgpt-web \
  --model gpt-5.6-sol-instant \
  --no-tools --no-session \
  -p 'Reply exactly PI_WEB_OK'
```

The package's compatibility target is the current `@earendil-works/pi-coding-agent`, not the legacy `@mariozechner/pi-coding-agent` package.

## License

MIT
