import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";

const PROVIDER_ID = "chatgpt-web";
const BASH_TOOL_NAME = "bash";
const SHELL_COMMAND_TOOL_NAME = "shell_command";
export const DEFAULT_BASE_URL = "http://127.0.0.1:17841/v1";
const STATUS_TIMEOUT_MS = 2500;
const MAX_DIRECT_IDENTITIES = 64;
const SUMMARY_PROTOCOL = Object.freeze({ implementation: "responses", strategy: "memento" });
const SUMMARY_KINDS = new Set(["compaction-summary", "turn-prefix-summary", "branch-summary"]);

const SHELL_COMMAND_PARAMETERS = Type.Object({
  command: Type.String({
    maxLength: 100000,
    description: "Shell command to execute through Pi's built-in bash tool",
  }),
  workdir: Type.Optional(Type.String({
    maxLength: 16384,
    description: "Working directory for the command",
  })),
  timeout_ms: Type.Optional(Type.Number({
    minimum: 1,
    maximum: 2147483647,
    description: "Command timeout in milliseconds",
  })),
}, { additionalProperties: false });

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function healthUrl(baseUrl) {
  const endpoint = normalizeBaseUrl(baseUrl);
  return `${endpoint.replace(/\/v1$/, "")}/healthz`;
}

export async function checkBridgeStatus(baseUrl = DEFAULT_BASE_URL, options = {}) {
  const endpoint = normalizeBaseUrl(baseUrl);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? STATUS_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(healthUrl(endpoint), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    let health = null;
    try {
      health = await response.json();
    } catch {
      health = null;
    }

    const healthy = response.ok
      && health?.service === "codex-chatgpt-web"
      && health?.status === "ok";

    return {
      endpoint,
      reachable: true,
      healthy,
      httpStatus: response.status,
      mode: typeof health?.mode === "string" ? health.mode : null,
      version: typeof health?.version === "string" ? health.version : null,
      acceptingTurns: health?.accepting_turns === true,
    };
  } catch (error) {
    return {
      endpoint,
      reachable: false,
      healthy: false,
      httpStatus: null,
      mode: null,
      version: null,
      acceptingTurns: false,
      error: error?.name === "AbortError" ? "request timed out" : (error?.message || String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function formatBridgeStatus(status) {
  if (!status.reachable) {
    return `ChatGPT Web bridge: unreachable${status.error ? ` (${status.error})` : ""}\nEndpoint: ${status.endpoint}`;
  }

  const state = status.healthy && status.acceptingTurns ? "ready" : "not ready";
  const details = [
    status.version ? `version ${status.version}` : null,
    status.mode ? `mode ${status.mode}` : null,
    status.httpStatus ? `HTTP ${status.httpStatus}` : null,
  ].filter(Boolean).join(", ");

  return `ChatGPT Web bridge: ${state}${details ? ` (${details})` : ""}\nEndpoint: ${status.endpoint}\nAccepting turns: ${status.acceptingTurns ? "yes" : "no"}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function shellCommandToBashArgs({ command, workdir, timeout_ms: timeoutMs }) {
  const bashArgs = {
    command: workdir ? `cd -- ${shellQuote(workdir)} && ${command}` : command,
  };
  if (timeoutMs !== undefined) bashArgs.timeout = timeoutMs / 1000;
  return bashArgs;
}

function toolName(tool) {
  if (!tool || typeof tool !== "object") return null;
  if (typeof tool.name === "string") return tool.name;
  if (typeof tool.function?.name === "string") return tool.function.name;
  return null;
}

export function guardShellCommandTools(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.tools)) return payload;
  const names = payload.tools.map(toolName);
  if (!names.includes(SHELL_COMMAND_TOOL_NAME) || names.includes(BASH_TOOL_NAME)) return payload;
  return {
    ...payload,
    tools: payload.tools.filter((tool) => toolName(tool) !== SHELL_COMMAND_TOOL_NAME),
  };
}

export async function executeShellCommand(params, signal, onUpdate, ctx) {
  if (!ctx?.tools?.some((tool) => tool?.name === BASH_TOOL_NAME)) {
    throw new Error("Pi bash tool is unavailable for this turn; shell_command will not create command authority");
  }

  const outcome = await ctx.executeTool(
    BASH_TOOL_NAME,
    shellCommandToBashArgs(params),
    { signal, onUpdate },
  );

  if (outcome.isError && !outcome.result?.isError) {
    return { ...outcome.result, isError: true };
  }
  return outcome.result;
}

export function createShellCommandTool() {
  return {
    name: SHELL_COMMAND_TOOL_NAME,
    label: "shell_command",
    description: "Compatibility alias for Codex Native command execution. Delegates to Pi's built-in bash tool through Pi's normal nested-tool pipeline.",
    parameters: SHELL_COMMAND_PARAMETERS,
    exposure: "direct",
    defaultActive: false,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    prepareLoadout(loadout) {
      return loadout.callable.some((tool) => tool?.name === BASH_TOOL_NAME)
        ? undefined
        : { hiddenDeclarations: [SHELL_COMMAND_TOOL_NAME] };
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return executeShellCommand(params, signal, onUpdate, ctx);
    },
  };
}

function uid(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function nativeId() {
  return crypto.randomUUID();
}

export function createTurnState() {
  return {
    turnId: nativeId(),
    userItemId: uid("msg"),
    environmentItemId: uid("msg"),
    requestCount: 0,
  };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function environmentMessage({ turnId, cwd, itemId }) {
  const path = xmlEscape(cwd);
  return {
    type: "message",
    role: "user",
    id: itemId,
    content: [{
      type: "input_text",
      text: `<environment_context>\n<cwd>${path}</cwd>\n<workspace_roots><root>${path}</root></workspace_roots>\n<sandbox_mode>danger-full-access</sandbox_mode>\n</environment_context>`,
    }],
    internal_chat_message_metadata_passthrough: {
      turn_id: turnId,
      content_item_kinds: ["environments.environment_context"],
    },
  };
}

export function bridgeModelId(modelId) {
  return modelId.startsWith("chatgpt-web/") ? modelId : `chatgpt-web/${modelId}`;
}

function tagCurrentUser(input, { turnId, userItemId }) {
  if (!Array.isArray(input)) return { input, lastUser: -1 };
  const tagged = input.map((item) => item && typeof item === "object" ? { ...item } : item);
  let lastUser = -1;
  for (let i = 0; i < tagged.length; i += 1) {
    if (tagged[i]?.role === "user") lastUser = i;
  }
  if (lastUser >= 0) {
    const user = tagged[lastUser];
    tagged[lastUser] = {
      ...user,
      type: "message",
      id: typeof user.id === "string" && user.id ? user.id : userItemId,
      internal_chat_message_metadata_passthrough: {
        ...(user.internal_chat_message_metadata_passthrough || {}),
        turn_id: turnId,
      },
    };
  }
  return { input: tagged, lastUser };
}

function isEnvironmentInputItem(item) {
  const kinds = item?.internal_chat_message_metadata_passthrough?.content_item_kinds;
  return Array.isArray(kinds) && kinds.includes("environments.environment_context");
}

export function decoratePayload(payload, {
  turnId,
  threadId,
  cwd,
  bridgeModel,
  userItemId,
  environmentItemId,
  requestKind = "ordinary-turn",
}) {
  if (!payload || typeof payload !== "object") return payload;

  const tagged = tagCurrentUser(payload.input, { turnId, userItemId });
  if (tagged.lastUser >= 0) {
    tagged.input.splice(tagged.lastUser, 0, environmentMessage({ turnId, cwd, itemId: environmentItemId }));
  }

  const turnMetadata = JSON.stringify({
    thread_id: threadId,
    turn_id: turnId,
    request_kind: "turn",
    sandbox: "none",
    workspaces: { [cwd]: {} },
    pi_request_kind: requestKind,
  });

  return {
    ...payload,
    model: bridgeModel,
    ...(tagged.input ? { input: tagged.input } : {}),
    client_metadata: {
      ...(payload.client_metadata || {}),
      "x-codex-turn-metadata": turnMetadata,
    },
  };
}

export function decorateSummaryPayload(payload, {
  turnId,
  threadId,
  bridgeModel,
  userItemId,
  summaryKind,
}) {
  if (!payload || typeof payload !== "object") return payload;
  const {
    tools: _tools,
    tool_choice: _toolChoice,
    parallel_tool_calls: _parallelToolCalls,
    ...toolLessPayload
  } = payload;
  const sourceInput = Array.isArray(toolLessPayload.input)
    ? toolLessPayload.input.filter((item) => !isEnvironmentInputItem(item))
    : toolLessPayload.input;
  const tagged = tagCurrentUser(sourceInput, { turnId, userItemId });
  const turnMetadata = JSON.stringify({
    thread_id: threadId,
    turn_id: turnId,
    request_kind: "compaction",
    compaction: SUMMARY_PROTOCOL,
    sandbox: "none",
    workspaces: {},
    pi_request_kind: summaryKind,
  });

  return {
    ...toolLessPayload,
    model: bridgeModel,
    ...(tagged.input ? { input: tagged.input } : {}),
    client_metadata: {
      ...(toolLessPayload.client_metadata || {}),
      "x-codex-turn-metadata": turnMetadata,
    },
  };
}

export function createChatGptWebExtension({ responsesApi = openAIResponsesApi() } = {}) {
  return function chatGptWebExtension(pi) {
    const baseUrl = process.env.PI_CHATGPT_WEB_BASE_URL || DEFAULT_BASE_URL;
    const localBearer = process.env.PI_CHATGPT_WEB_API_KEY || "pi-chatgpt-web-local";
    let fallbackThreadId = nativeId();
    let activeSessionId = null;
    let activeTurn = null;
    let currentCwd = process.cwd();
    let shellCommandRegistered = false;
    const summaryPlans = new WeakMap();
    const directIdentities = new Map();

    const ensureShellCommandRegistered = () => {
      if (shellCommandRegistered) return;
      if (!pi.getAllTools().some((tool) => tool.name === BASH_TOOL_NAME)) return;
      pi.registerTool(createShellCommandTool());
      shellCommandRegistered = true;
    };

    const syncShellCommandActivation = (ctx) => {
      ensureShellCommandRegistered();
      if (!shellCommandRegistered) return;

      const activeTools = pi.getActiveTools();
      const shellActive = activeTools.includes(SHELL_COMMAND_TOOL_NAME);
      const shouldActivate = ctx.model?.provider === PROVIDER_ID && activeTools.includes(BASH_TOOL_NAME);
      if (shouldActivate === shellActive) return;

      pi.setActiveTools(shouldActivate
        ? [...activeTools, SHELL_COMMAND_TOOL_NAME]
        : activeTools.filter((name) => name !== SHELL_COMMAND_TOOL_NAME));
    };

    const rememberDirectIdentity = (routingId) => {
      const key = typeof routingId === "string" && routingId ? routingId : nativeId();
      const existing = directIdentities.get(key);
      if (existing) return existing;
      const identity = {
        threadId: key,
        turnId: nativeId(),
        userItemId: uid("msg"),
        environmentItemId: uid("msg"),
      };
      directIdentities.set(key, identity);
      if (directIdentities.size > MAX_DIRECT_IDENTITIES) {
        directIdentities.delete(directIdentities.keys().next().value);
      }
      return identity;
    };

    const registerSummaryPlan = (signal, kinds) => {
      const filtered = kinds.filter((kind) => SUMMARY_KINDS.has(kind));
      if (!signal || filtered.length === 0) return;
      summaryPlans.set(signal, { kinds: filtered, next: 0, byRoutingId: new Map() });
    };

    const summaryKindFor = (options) => {
      const plan = options?.signal ? summaryPlans.get(options.signal) : undefined;
      if (!plan) return null;
      const routingId = typeof options?.sessionId === "string" && options.sessionId
        ? options.sessionId
        : null;
      if (routingId && plan.byRoutingId.has(routingId)) return plan.byRoutingId.get(routingId);
      const kind = plan.kinds[plan.next] ?? null;
      if (!kind) return null;
      plan.next += 1;
      if (routingId) plan.byRoutingId.set(routingId, kind);
      return kind;
    };

    const debugRequest = (kind, route) => {
      if (process.env.PI_CHATGPT_WEB_DEBUG !== "1") return;
      console.error(`[pi-chatgpt-web] request kind=${kind} route=${route}`);
    };

    const streamSimple = (model, context, options = {}) => {
      const summaryKind = summaryKindFor(options);
      const normalAgentRequest = !summaryKind
        && activeSessionId !== null
        && options.sessionId === activeSessionId;
      let identity;
      let requestKind;

      if (summaryKind) {
        identity = rememberDirectIdentity(options.sessionId);
        requestKind = summaryKind;
      } else if (normalAgentRequest) {
        if (!activeTurn) activeTurn = createTurnState();
        identity = {
          threadId: fallbackThreadId,
          turnId: activeTurn.turnId,
          userItemId: activeTurn.userItemId,
          environmentItemId: activeTurn.environmentItemId,
        };
        requestKind = activeTurn.requestCount === 0 ? "ordinary-turn" : "tool-continuation";
        activeTurn.requestCount += 1;
      } else {
        identity = rememberDirectIdentity(options.sessionId);
        requestKind = "direct";
      }

      const originalOnPayload = options.onPayload;
      return responsesApi.streamSimple(model, context, {
        ...options,
        onPayload: async (payload) => {
          let nextPayload = typeof originalOnPayload === "function"
            ? (await originalOnPayload(payload)) ?? payload
            : payload;
          nextPayload = guardShellCommandTools(nextPayload);
          const bridgeModel = bridgeModelId(model.id);
          if (summaryKind) {
            const decorated = decorateSummaryPayload(nextPayload, {
              turnId: identity.turnId,
              threadId: identity.threadId,
              bridgeModel,
              userItemId: identity.userItemId,
              summaryKind,
            });
            debugRequest(summaryKind, "compaction");
            return decorated;
          }
          const decorated = decoratePayload(nextPayload, {
            turnId: identity.turnId,
            threadId: identity.threadId,
            cwd: currentCwd,
            bridgeModel,
            userItemId: identity.userItemId,
            environmentItemId: identity.environmentItemId,
            requestKind,
          });
          debugRequest(requestKind, "turn");
          return decorated;
        },
      });
    };

    pi.registerCommand("chatgpt-web-status", {
      description: "Check ChatGPT Web bridge health and readiness",
      handler: async (_args, ctx) => {
        const status = await checkBridgeStatus(baseUrl);
        ctx.ui.notify(formatBridgeStatus(status), status.healthy && status.acceptingTurns ? "info" : "error");
      },
    });

    pi.registerProvider(PROVIDER_ID, {
      name: "ChatGPT Web",
      baseUrl,
      apiKey: localBearer,
      api: "openai-responses",
      authHeader: true,
      streamSimple,
      models: [
        {
          id: "gpt-5.6-sol-instant",
          name: "GPT-5.6 Sol Instant (Web)",
          api: "openai-responses",
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 41000,
          maxTokens: 8192
        },
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol (Web)",
          api: "openai-responses",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 90000,
          maxTokens: 16384
        }
      ]
    });

    pi.on("session_start", (_event, ctx) => {
      fallbackThreadId = nativeId();
      activeSessionId = ctx.sessionManager?.getSessionId?.() ?? null;
      activeTurn = null;
      currentCwd = ctx.cwd || process.cwd();
      directIdentities.clear();
      syncShellCommandActivation(ctx);
    });

    pi.on("before_agent_start", (_event, ctx) => {
      activeSessionId = ctx.sessionManager?.getSessionId?.() ?? activeSessionId;
      currentCwd = ctx.cwd || currentCwd;
      syncShellCommandActivation(ctx);
      activeTurn = createTurnState();
    });

    pi.on("agent_end", () => {
      activeTurn = null;
    });

    pi.on("session_before_compact", (event) => {
      const kinds = [];
      if (event.preparation.isSplitTurn) {
        if (event.preparation.messagesToSummarize?.length > 0) kinds.push("compaction-summary");
        if (event.preparation.turnPrefixMessages?.length > 0) kinds.push("turn-prefix-summary");
      } else if (event.preparation.messagesToSummarize?.length > 0) {
        kinds.push("compaction-summary");
      }
      registerSummaryPlan(event.signal, kinds);
    });

    pi.on("session_before_tree", (event) => {
      if (event.preparation.userWantsSummary && event.preparation.entriesToSummarize?.length > 0) {
        registerSummaryPlan(event.signal, ["branch-summary"]);
      }
    });

    pi.on("before_provider_request", (event, ctx) => {
      if (ctx.model?.provider !== PROVIDER_ID) return;
      return guardShellCommandTools(event.payload);
    });
  };
}

export default createChatGptWebExtension();
