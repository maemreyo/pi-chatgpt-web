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

> **Version note:** `v0.1.0` targeted the older `@mariozechner/pi-coding-agent` package and is deprecated. Use `v0.2.5` or newer for `earendil-works/pi`.

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
pi install git:github.com/maemreyo/pi-chatgpt-web@main
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

From v0.2.3, it also shows the last provider failure observed in the current Pi process. The command checks the bridge's unauthenticated `/healthz` endpoint derived from `PI_CHATGPT_WEB_BASE_URL` (or the default `http://127.0.0.1:17841/v1`). It reports whether the expected `codex-chatgpt-web` service is healthy and accepting turns, plus the bridge version and mode when available. It intentionally does not use `/v1/models`: that route is a native Codex passthrough and requires upstream ChatGPT Bearer authentication that this Pi extension does not own.

From v0.2.5, the same command also reports context-budget provenance and keeps three values separate: the bridge's raw context window, the smaller context window advertised to Pi, and the effective safe compaction threshold. For a ChatGPT Plus, non-Pro Sol Medium/High route on `codex-chatgpt-web` 6.1.4 with `experimentalBiggerContext=true`, those values are `270000`, `256384`, and `240000` tokens respectively. The `256384` Pi window is deliberate: with Pi's default `16384` reserve it makes Pi compact at `240000`, no later than the bridge's auto-compact boundary. A stricter user compaction policy is never relaxed by this extension. The extension reads the effective policy through public pi.getSettings(), including per-model overrides. A reserve below 16384 reduces the advertised window to retain the bridge boundary; a larger reserve keeps earlier compaction (reserve 40000 gives threshold 216384). Disabled automatic compaction remains disabled. Status reports the effective reserve/threshold or explicitly marks an unavailable policy, in which case the window is capped conservatively. Idle input refresh runs before Pi checks pre-turn compaction. No Pi settings are written.

`codex-chatgpt-web` 6.1.4 does not expose a dedicated unauthenticated budget-metadata endpoint. For the exact default loopback endpoint only, v0.2.5 therefore combines validated `/healthz` version/mode metadata with a bounded, version-matched snapshot of `~/.codex-chatgpt-web/config.json`. It accepts only the expected schema/release/host/port/mode and the four capability booleans needed for budget derivation (`solAvailable`, `proAvailable`, `extraHighAvailable`, `experimentalBiggerContext`). A custom or remote `PI_CHATGPT_WEB_BASE_URL` never inherits this local-default config; if authoritative metadata cannot be verified, the extension fails closed to the conservative pre-v0.2.5 windows.

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

From v0.2.3, summaries exclude the bridge's Codex-specific latest-prompt appendix when it exactly matches the current summary request. This prevents the full history from being stored again as part of the summary. Ordinary assistant replies retain their original content. Summary text is delivered after validation; normal turns continue streaming incrementally. Reported usage still includes the actual upstream summary generation, including any tokens the bridge spent on its appendix.

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
- preserves the same turn identity when Pi sends tool results back to the bridge;
- derives conservative Pi context-window metadata from verified bridge capabilities and refreshes the active model object when effort or Bigger Context changes, without writing Pi compaction settings.

Stable item IDs are important. Regenerating the current user message ID on a tool-result continuation causes `codex-chatgpt-web` to reject the earlier browser response as superseded.

## Security and privacy

The extension does **not** use, copy, or persist:

- ChatGPT cookies;
- ChatGPT browser profile data;
- OpenAI API keys;
- `codex-chatgpt-web` tunnel runtime credentials.

For v0.2.5 context-budget derivation, and only when using the exact default loopback bridge, the extension reads a bounded local `~/.codex-chatgpt-web/config.json` snapshot and uses only schema/release/endpoint/mode provenance plus the four capability booleans listed above. It does not log or forward the file contents, and it never applies that local snapshot to a custom or remote bridge URL.

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

Update to `pi-chatgpt-web` v0.2.4 or newer. User message identities now remain stable across tool rounds, history, resumed sessions, and abort recovery so the bridge can prove instruction lineage.

### Auto-compaction fails with a native authentication / 401 error

Update to `pi-chatgpt-web` v0.2.2 or newer. Earlier builds only rewrote ordinary provider requests; Pi summary requests could bypass that hook and reach the wrong native-auth route.

### Browser acknowledgement or submitted-turn failure

From v0.2.3, the extension disables SDK HTTP replay and prevents Pi from automatically replaying known post-submission browser failures. The prompt may already have been accepted by ChatGPT, and tools may already have run. Pi reports that manual recovery is required instead of silently sending the task again.

Run /chatgpt-web-status in the same Pi process to see a process-local recovery receipt: original error, submitted/unknown/error classification, explicit submission evidence when it exists, observed phase, SDK stream-start state, request kind, and the provider-generated correlation IDs used in outbound metadata. Those local correlation IDs are not claimed as observed ChatGPT conversation/turn receipts; upstream identity remains UNKNOWN unless the bridge actually exposes it. SDK `start` is also not submission evidence. For submitted or ambiguous outcomes, reconcile ChatGPT browser state/receipts before any replay; never automatically replay a possibly mutating request.

The same status command reports separate package/provider/model-effort/auth/Pi-tool layers. Package metadata and provider/tool registration are local observations; model-effort availability is only AVAILABLE when the bounded bridge capability snapshot is verified; authentication remains UNKNOWN unless an auth failure was actually observed. Missing evidence stays UNKNOWN rather than being inferred.

Bridge health is a separate layer. A healthy /healthz response means the local bridge is reachable and accepting turns; it does not prove long-running upstream browser reliability or that a failed turn completed. Partial or malformed streams fail closed, only one terminal event is forwarded, late post-terminal content/tools are dropped, and caller cancellation suppresses late deltas/tool calls even if the source ignores abort. Only explicit connection-refused failures remain eligible for Pi's normal retry policy. Generic transport failures, 502/504 and 429 do not prove that submission never happened and require manual recovery. This adapter does not guarantee recovery from a stopped upstream ChatGPT response or change bridge deadlines.

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

Acceptance scripts run separate temporary Pi sessions against an already-running bridge. They do not restart Pi, Workbench, or the bridge:

```bash
python3 scripts/live-acceptance.py manual --output /tmp/pi-web-manual-unique
python3 scripts/live-acceptance.py auto --output /tmp/pi-web-auto-unique
python3 scripts/live-acceptance.py native --output /tmp/pi-web-native-unique
python3 scripts/retry-acceptance.py --output /tmp/pi-web-retry-unique
```

Each output directory must be new. The retry acceptance uses a local HTTP failure fixture and actual Pi CLI with retries enabled; it does not send to ChatGPT. Live compaction acceptance verifies a saved summary without the control appendix, a smaller next request, and recall without repeating the expected marker in the follow-up question.

## License

MIT

### Deep E2E stress suite

The [deep audit](docs/DEEP_E2E_2026-10-03.md) includes Instant, Medium and High multi-tool/resume tests, all Pi summary paths, isolated concurrent actors, tool abort recovery, queued follow-up, image input, Firefox companion automation, installed review integration, HTTP/SSE fault injection, and nested tool authority checks. Reproducible scripts and sanitized machine evidence are retained in this repository. Use a new output directory for each run; live cases consume ChatGPT requests.

New independent review acceptance runs select **Sol High**. The recorded Medium/Instant runs are historical regression evidence. Use Sol High for new live model work unless a different effort is explicitly requested.

### Community readiness validation (2026-10-05)

The Git build is package version 0.2.6; v0.2.5 remains the existing release tag. No npm publication is claimed. Provider/stream tests cover 54 cases. Actual Pi 1.0 RPC, Sol High, with retry enabled sent exactly one request and no retry event for locally injected multipart acknowledgement timeout, submitted failure, and truncated SSE. These are failure-injection integration checks, not browser DEV acceptance or proof of long-task reliability. A live bridge attempt returned `browser_response_interrupted`; its outcome remains subject to receipt reconciliation, with no automatic replay. The v0.2.5 context-budget implementation is unchanged.

A subsequent fresh isolated live Pi 1.0 RPC acceptance used Sol High and this 0.2.6 extension against the existing bridge: two actual `shell_command` executions passed, including an expected nonexistent-workdir failure, a quoted directory, exact output bytes, and no wrong-directory write. This is native-tool integration acceptance; it does not establish that upstream long-task interruptions are eliminated. Earlier failed attempts were not automatically replayed.
