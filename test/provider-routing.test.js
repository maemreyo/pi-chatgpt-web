import test from "node:test";
import assert from "node:assert/strict";
import { createChatGptWebExtension } from "../extensions/chatgpt-web.js";

const MODEL = {
  provider: "chatgpt-web",
  id: "gpt-5.6-sol",
  api: "openai-responses",
};

function makeFakeResponsesApi() {
  const calls = [];
  return {
    calls,
    streamSimple(model, context, options) {
      const call = { model, context, options };
      calls.push(call);
      return { call };
    },
  };
}

function makeFakePi() {
  const handlers = new Map();
  const providers = new Map();
  const tools = [{ name: "bash" }, { name: "read" }, { name: "write" }, { name: "edit" }];
  let activeTools = tools.map((tool) => tool.name);

  return {
    handlers,
    providers,
    api: {
      registerCommand() {},
      registerProvider(id, config) {
        providers.set(id, config);
      },
      registerTool(tool) {
        tools.push({ name: tool.name });
      },
      on(name, handler) {
        handlers.set(name, handler);
        return () => {};
      },
      getAllTools() {
        return [...tools];
      },
      getActiveTools() {
        return [...activeTools];
      },
      setActiveTools(next) {
        activeTools = [...next];
      },
    },
  };
}

function sessionContext(sessionId = "11111111-1111-7111-8111-111111111111") {
  return {
    cwd: "/tmp/pi-chatgpt-web-routing-test",
    model: MODEL,
    sessionManager: { getSessionId: () => sessionId },
  };
}

function requestPayload() {
  return {
    model: "gpt-5.6-sol",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "summarize this" }],
      },
    ],
    tools: [
      { type: "function", name: "read" },
      { type: "function", name: "bash" },
      { type: "function", name: "shell_command" },
    ],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
}

function metadata(payload) {
  return JSON.parse(payload.client_metadata["x-codex-turn-metadata"]);
}

async function send(provider, responsesApi, options, payload = requestPayload()) {
  provider.streamSimple(MODEL, { messages: [] }, options);
  const call = responsesApi.calls.at(-1);
  assert.ok(call, "provider must delegate to the built-in Responses API");
  return call.options.onPayload(payload);
}

function setup() {
  const responsesApi = makeFakeResponsesApi();
  const pi = makeFakePi();
  createChatGptWebExtension({ responsesApi })(pi.api);
  const provider = pi.providers.get("chatgpt-web");
  assert.ok(provider);
  return { responsesApi, pi, provider };
}

test("provider transport rewrites ordinary turns and keeps turn identity across tool continuations", async () => {
  const { responsesApi, pi, provider } = setup();
  const ctx = sessionContext();
  await pi.handlers.get("session_start")({}, ctx);
  await pi.handlers.get("before_agent_start")({}, ctx);

  const options = {
    sessionId: ctx.sessionManager.getSessionId(),
    apiKey: "pi-chatgpt-web-local",
    onPayload: async (payload) => pi.handlers.get("before_provider_request")(
      { payload },
      ctx,
    ) ?? payload,
  };

  const first = await send(provider, responsesApi, options);
  const second = await send(provider, responsesApi, options);

  assert.equal(first.model, "chatgpt-web/gpt-5.6-sol");
  assert.equal(second.model, "chatgpt-web/gpt-5.6-sol");
  assert.equal(metadata(first).request_kind, "turn");
  assert.equal(metadata(first).pi_request_kind, "ordinary-turn");
  assert.equal(metadata(second).pi_request_kind, "tool-continuation");
  assert.equal(metadata(first).thread_id, metadata(second).thread_id);
  assert.equal(metadata(first).turn_id, metadata(second).turn_id);
  assert.equal(first.input.at(-1).id, second.input.at(-1).id);
  assert.equal(first.input[0].id, second.input[0].id);
  assert.deepEqual(metadata(first).workspaces, { "/tmp/pi-chatgpt-web-routing-test": {} });
  assert.equal(first.tools.some((tool) => tool.name === "bash"), true);
});

test("manual and automatic compaction use the same provider-level ChatGPT Web route", async () => {
  for (const reason of ["manual", "threshold"]) {
    const { responsesApi, pi, provider } = setup();
    const ctx = sessionContext();
    await pi.handlers.get("session_start")({}, ctx);

    const controller = new AbortController();
    await pi.handlers.get("session_before_compact")({
      signal: controller.signal,
      reason,
      preparation: {
        isSplitTurn: false,
        messagesToSummarize: [{}],
        turnPrefixMessages: [],
      },
    });

    const output = await send(provider, responsesApi, {
      sessionId: `22222222-2222-7222-8222-${reason === "manual" ? "111111111111" : "222222222222"}`,
      signal: controller.signal,
      apiKey: "pi-chatgpt-web-local",
    });
    const meta = metadata(output);

    assert.equal(output.model, "chatgpt-web/gpt-5.6-sol");
    assert.equal(meta.request_kind, "compaction");
    assert.deepEqual(meta.compaction, { implementation: "responses", strategy: "memento" });
    assert.equal(meta.pi_request_kind, "compaction-summary");
    assert.deepEqual(meta.workspaces, {});
    assert.equal(Object.hasOwn(output, "tools"), false);
    assert.equal(Object.hasOwn(output, "tool_choice"), false);
    assert.equal(Object.hasOwn(output, "parallel_tool_calls"), false);
    assert.equal(output.input.some((item) =>
      item.internal_chat_message_metadata_passthrough?.content_item_kinds?.includes("environments.environment_context")
    ), false);
  }
});

test("split-turn summary retries keep stable identity and the prefix gets a distinct control identity", async () => {
  const { responsesApi, pi, provider } = setup();
  const ctx = sessionContext();
  await pi.handlers.get("session_start")({}, ctx);

  const controller = new AbortController();
  await pi.handlers.get("session_before_compact")({
    signal: controller.signal,
    reason: "manual",
    preparation: {
      isSplitTurn: true,
      messagesToSummarize: [{}],
      turnPrefixMessages: [{}],
    },
  });

  const historyOptions = {
    sessionId: "33333333-3333-7333-8333-333333333333",
    signal: controller.signal,
    apiKey: "pi-chatgpt-web-local",
  };
  const firstHistory = await send(provider, responsesApi, historyOptions);
  const retryHistory = await send(provider, responsesApi, historyOptions);
  const prefix = await send(provider, responsesApi, {
    sessionId: "44444444-4444-7444-8444-444444444444",
    signal: controller.signal,
    apiKey: "pi-chatgpt-web-local",
  });

  assert.equal(metadata(firstHistory).pi_request_kind, "compaction-summary");
  assert.equal(metadata(retryHistory).pi_request_kind, "compaction-summary");
  assert.equal(
    firstHistory.client_metadata["x-codex-turn-metadata"],
    retryHistory.client_metadata["x-codex-turn-metadata"],
  );
  assert.equal(firstHistory.input.at(-1).id, retryHistory.input.at(-1).id);

  assert.equal(metadata(prefix).pi_request_kind, "turn-prefix-summary");
  assert.notEqual(metadata(prefix).thread_id, metadata(firstHistory).thread_id);
  assert.notEqual(metadata(prefix).turn_id, metadata(firstHistory).turn_id);
});

test("branch summarization is routed as a tool-less browser compaction request", async () => {
  const { responsesApi, pi, provider } = setup();
  const ctx = sessionContext();
  await pi.handlers.get("session_start")({}, ctx);

  const controller = new AbortController();
  await pi.handlers.get("session_before_tree")({
    signal: controller.signal,
    preparation: {
      userWantsSummary: true,
      entriesToSummarize: [{}],
    },
  });

  const output = await send(provider, responsesApi, {
    sessionId: "55555555-5555-7555-8555-555555555555",
    signal: controller.signal,
    apiKey: "pi-chatgpt-web-local",
  });
  const meta = metadata(output);

  assert.equal(meta.request_kind, "compaction");
  assert.equal(meta.pi_request_kind, "branch-summary");
  assert.deepEqual(meta.compaction, { implementation: "responses", strategy: "memento" });
  assert.equal(Object.hasOwn(output, "tools"), false);
});

test("Sol control summaries inherit session thinking or Medium, while ordinary requests keep their settings", async () => {
  for (const [selected, explicit, expected] of [[undefined, undefined, "medium"], ["off", undefined, "medium"], ["high", undefined, "high"], ["high", "medium", "medium"]]) {
    const { responsesApi, pi, provider } = setup();
    pi.api.getThinkingLevel = () => selected;
    const controller = new AbortController();
    await pi.handlers.get("session_before_tree")({ signal: controller.signal,
      preparation: { userWantsSummary: true, entriesToSummarize: [{}] } });
    provider.streamSimple({ ...MODEL, reasoning: true }, { messages: [] },
      { signal: controller.signal, sessionId: "branch", ...(explicit ? { reasoning: explicit } : {}) });
    assert.equal(responsesApi.calls.at(-1).options.reasoning, expected);
    provider.streamSimple({ ...MODEL, reasoning: true }, { messages: [] }, { sessionId: "ordinary-direct" });
    assert.equal(responsesApi.calls.at(-1).options.reasoning, undefined);
  }
});

test("direct summary routing never exposes the placeholder bearer as native Codex model routing", async () => {
  const { responsesApi, pi, provider } = setup();
  const ctx = sessionContext();
  await pi.handlers.get("session_start")({}, ctx);

  const controller = new AbortController();
  await pi.handlers.get("session_before_compact")({
    signal: controller.signal,
    reason: "manual",
    preparation: {
      isSplitTurn: false,
      messagesToSummarize: [{}],
      turnPrefixMessages: [],
    },
  });

  const options = {
    sessionId: "66666666-6666-7666-8666-666666666666",
    signal: controller.signal,
    apiKey: "pi-chatgpt-web-local",
  };
  const output = await send(provider, responsesApi, options);

  assert.equal(responsesApi.calls.at(-1).options.apiKey, "pi-chatgpt-web-local");
  assert.equal(output.model, "chatgpt-web/gpt-5.6-sol");
  assert.equal(metadata(output).request_kind, "compaction");
  assert.equal(JSON.stringify(output).includes("pi-chatgpt-web-local"), false);
});
