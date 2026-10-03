const PROVIDER_ID = "chatgpt-web";
const DEFAULT_BASE_URL = "http://127.0.0.1:17841/v1";

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

export function decoratePayload(payload, { turnId, threadId, cwd, bridgeModel, userItemId, environmentItemId }) {
  if (!payload || typeof payload !== "object") return payload;

  const input = Array.isArray(payload.input)
    ? payload.input.map((item) => item && typeof item === "object" ? { ...item } : item)
    : payload.input;

  if (Array.isArray(input)) {
    let lastUser = -1;
    for (let i = 0; i < input.length; i += 1) {
      if (input[i]?.role === "user") lastUser = i;
    }
    if (lastUser >= 0) {
      const user = input[lastUser];
      input[lastUser] = {
        ...user,
        type: "message",
        id: typeof user.id === "string" && user.id ? user.id : userItemId,
        internal_chat_message_metadata_passthrough: {
          ...(user.internal_chat_message_metadata_passthrough || {}),
          turn_id: turnId,
        },
      };
      input.splice(lastUser, 0, environmentMessage({ turnId, cwd, itemId: environmentItemId }));
    }
  }

  const turnMetadata = JSON.stringify({
    thread_id: threadId,
    turn_id: turnId,
    request_kind: "turn",
    sandbox: "none",
    workspaces: { [cwd]: {} },
  });

  return {
    ...payload,
    model: bridgeModel,
    ...(input ? { input } : {}),
    client_metadata: {
      ...(payload.client_metadata || {}),
      "x-codex-turn-metadata": turnMetadata,
    },
  };
}

export default function chatGptWebExtension(pi) {
  const baseUrl = process.env.PI_CHATGPT_WEB_BASE_URL || DEFAULT_BASE_URL;
  const localBearer = process.env.PI_CHATGPT_WEB_API_KEY || "pi-chatgpt-web-local";
  let fallbackThreadId = nativeId();
  let activeTurn = null;

  pi.registerProvider(PROVIDER_ID, {
    name: "ChatGPT Web",
    baseUrl,
    apiKey: localBearer,
    api: "openai-responses",
    authHeader: true,
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

  pi.on("session_start", () => {
    fallbackThreadId = nativeId();
    activeTurn = null;
  });

  pi.on("before_agent_start", () => {
    activeTurn = createTurnState();
  });

  pi.on("agent_end", () => {
    activeTurn = null;
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return;
    const payload = event.payload;
    if (!payload || typeof payload !== "object") return;

    if (!activeTurn) activeTurn = createTurnState();
    const turn = activeTurn;
    const threadId = fallbackThreadId;
    const modelId = typeof ctx.model?.id === "string" ? ctx.model.id : payload.model;

    return decoratePayload(payload, {
      turnId: turn.turnId,
      threadId,
      cwd: ctx.cwd || process.cwd(),
      bridgeModel: bridgeModelId(modelId),
      userItemId: turn.userItemId,
      environmentItemId: turn.environmentItemId,
    });
  });
}
