import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, isRetryableAssistantError, AssistantMessageFrameEncoder, reduceAssistantMessageFrames } from "@earendil-works/pi-ai/compat";
import {
  cleanSummaryMessage,
  createFailureObservation,
  formatFailureObservation,
  manualRecoveryCode,
  stripCompactionAppendix,
  wrapBridgeStream,
} from "../extensions/bridge-stream.js";

const MODEL = { api: "openai-responses", provider: "chatgpt-web", id: "gpt-5.6-sol" };
function message(text, extra = {}) {
  return { role: "assistant", content: [{ type: "text", text }], ...MODEL, model: MODEL.id,
    usage: { input: 12000, output: 3000, cacheRead: 0, cacheWrite: 0, totalTokens: 15000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: 1, stopReason: "stop", ...extra };
}
function sourceFor(result, split = 1) {
  const source = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const partial = { ...result, content: [], stopReason: "pending" };
    source.push({ type: "start", partial });
    partial.content.push({ type: "text", text: "" });
    source.push({ type: "text_start", contentIndex: 0, partial });
    const text = result.content.map(c => c.text || "").join("");
    for (let i = 0; i < text.length; i += split) {
      const delta = text.slice(i, i + split);
      partial.content[0].text += delta;
      source.push({ type: "text_delta", contentIndex: 0, delta, partial });
    }
    source.push({ type: "text_end", contentIndex: 0, content: text, partial });
    source.push({ type: "done", reason: result.stopReason, message: result });
    source.end();
  });
  return source;
}

test("failure observations separate explicit submission evidence from local correlation and SDK stream start", () => {
  const submittedMessage = message("", {
    stopReason: "error",
    errorMessage: "chatgpt_submitted_turn_failed: ChatGPT stopped responding after the task started",
  });
  const submitted = createFailureObservation(submittedMessage, {
    code: manualRecoveryCode(submittedMessage),
    diagnosticContext: {
      requestKind: "ordinary-turn",
      correlationTurnId: "turn-local",
      correlationThreadId: "thread-local",
      correlationProvenance: "pi-provider-generated request metadata",
    },
    at: "2026-10-05T05:00:00.000Z",
  });
  assert.deepEqual(submitted, {
    at: "2026-10-05T05:00:00.000Z",
    classification: "submitted",
    code: "chatgpt_submitted_turn_failed",
    submission: "SUBMITTED",
    phase: "submitted_turn",
    sdkStreamStarted: "NO",
    requestKind: "ordinary-turn",
    correlationThreadId: "thread-local",
    correlationTurnId: "turn-local",
    correlationProvenance: "pi-provider-generated request metadata",
    upstreamThreadId: "UNKNOWN",
    upstreamTurnId: "UNKNOWN",
    upstreamIdentityProvenance: "UNKNOWN",
    message: submittedMessage.errorMessage,
    recovery: "RECONCILE_BEFORE_REPLAY",
  });

  const streamOnly = createFailureObservation(message("", {
    stopReason: "error",
    errorMessage: "Connection lost.",
  }), {
    code: "browser_response_interrupted",
    streamStarted: true,
    at: "2026-10-05T05:01:00.000Z",
  });
  assert.equal(streamOnly.classification, "unknown");
  assert.equal(streamOnly.submission, "UNKNOWN");
  assert.equal(streamOnly.phase, "response_stream");
  assert.equal(streamOnly.sdkStreamStarted, "YES");
  assert.equal(streamOnly.upstreamThreadId, "UNKNOWN");
  assert.match(formatFailureObservation(streamOnly), /SDK stream started: YES \(not submission evidence\)/);
  assert.match(formatFailureObservation(streamOnly), /Observed upstream identity: thread=UNKNOWN, turn=UNKNOWN/);
  assert.match(formatFailureObservation(streamOnly), /reconcile ChatGPT browser state\/receipts before any replay/);

  const stageTimeout = createFailureObservation(message("", {
    stopReason: "error",
    errorMessage: "multipart_stage_5_acknowledgement",
  }), {
    code: "multipart_stage_5_acknowledgement",
  });
  assert.equal(stageTimeout.classification, "unknown");
  assert.equal(stageTimeout.submission, "UNKNOWN");

  const ordinary = createFailureObservation(message("", {
    stopReason: "error",
    errorMessage: "401 ChatGPT sign-in required",
  }), {
    at: "2026-10-05T05:02:00.000Z",
  });
  assert.equal(ordinary.classification, "error");
  assert.equal(ordinary.submission, "UNKNOWN");
  assert.equal(ordinary.code, "UNKNOWN");
  assert.equal(ordinary.phase, "UNKNOWN");
  assert.equal(ordinary.recovery, "STANDARD_ERROR_HANDLING");
});

test("only an exact, valid canonical prompt appendix is removed", () => {
  const prompt = 'history "quotes"\nCODEX_LATEST_USER_PROMPT_JSON\nstill history';
  const text = "Keep the user's objective.\n\nCODEX_LATEST_USER_PROMPT_JSON\n" + JSON.stringify(prompt);
  assert.equal(stripCompactionAppendix(text, prompt), "Keep the user's objective.");
  for (const expected of ["different request", undefined]) assert.equal(stripCompactionAppendix(text, expected), text);
  for (const suffix of ["not JSON", "{}","42", JSON.stringify(prompt) + "\nLater important text"]) {
    const ambiguous = "Important.\nCODEX_LATEST_USER_PROMPT_JSON\n" + suffix;
    assert.equal(stripCompactionAppendix(ambiguous, prompt), ambiguous);
  }
});

test("a trailer split across text blocks is removed without mutating source or usage", () => {
  const prompt = "long source history";
  const input = message("", { content: [
    { type: "thinking", thinking: "Preserve the decision." },
    { type: "text", text: "Decision: KEEP.\n\nCODEX_LATEST_", textSignature: "old" },
    { type: "text", text: "USER_PROMPT_JSON\n" + JSON.stringify(prompt) },
  ] });
  const original = structuredClone(input);
  const result = cleanSummaryMessage(input, prompt);
  assert.deepEqual(input, original);
  assert.deepEqual(result.content, [{ type: "thinking", thinking: "Preserve the decision." }, { type: "text", text: "Decision: KEEP." }]);
  assert.deepEqual(result.usage, input.usage);
  assert.throws(() => cleanSummaryMessage(message("\nCODEX_LATEST_USER_PROMPT_JSON\n" + JSON.stringify(prompt)), prompt), /empty summary/);
});

test("summary streaming and result both exclude a canonical appendix split into tiny deltas", async () => {
  const prompt = "source filler ".repeat(4000);
  const result = message("Decision: KEEP.\n\nCODEX_LATEST_USER_PROMPT_JSON\n" + JSON.stringify(prompt));
  const stream = wrapBridgeStream(sourceFor(result, 7), { model: MODEL, summary: true, expectedPrompt: () => prompt });
  const frames = [];
  const encoder = new AssistantMessageFrameEncoder();
  let visible = "";
  for await (const e of stream) {
    const f = encoder.encode(e);
    if (f) frames.push(f);
    if (e.type === "text_delta") visible += e.delta;
  }
  const final = await stream.result();
  assert.equal(visible, "Decision: KEEP.");
  assert.equal(final.content[0].text, visible);
  assert.equal(reduceAssistantMessageFrames(frames).content[0].text, visible);
  assert.deepEqual(final.usage, result.usage);
});

test("summary replay preserves redacted thinking without inventing reasoning deltas", async () => {
  const source = createAssistantMessageEventStream();
  const final = message("", { content: [
    { type: "thinking", thinking: "", thinkingSignature: "redacted-signature", redacted: true },
    { type: "text", text: "Keep the decision." },
  ] });
  source.push({ type: "start", partial: { ...final, content: [] } });
  source.push({ type: "done", reason: "stop", message: final }); source.end();
  const stream = wrapBridgeStream(source, { model: MODEL, summary: true });
  const events = [];
  for await (const e of stream) events.push(e);
  assert.equal(events.some(e => e.type === "thinking_delta"), false);
  assert.equal((await stream.result()).content[0].thinkingSignature, "redacted-signature");
});

test("ordinary responses retain text, signatures and incremental tool events", async () => {
  const result = message("Ordinary text.\nCODEX_LATEST_USER_PROMPT_JSON\n\"literal\"");
  const stream = wrapBridgeStream(sourceFor(result, 2), { model: MODEL, expectedPrompt: () => "literal" });
  const deltas = [];
  for await (const e of stream) if (e.type === "text_delta") deltas.push(e.delta);
  assert.equal(deltas.join(""), result.content[0].text);
  assert.strictEqual(await stream.result(), result);
  assert.ok(deltas.length > 1);
  const source = createAssistantMessageEventStream();
  const toolResult = message("", { content: [{ type: "toolCall", id: "call1", name: "bash", arguments: { command: "pwd" } }], stopReason: "toolUse" });
  const e = { type: "toolcall_end", contentIndex: 0, toolCall: toolResult.content[0], partial: toolResult };
  source.push({ type: "start", partial: { ...toolResult, content: [] } });
  source.push(e);
  source.push({ type: "done", reason: "toolUse", message: toolResult });
  source.end();
  const wrapped = wrapBridgeStream(source, { model: MODEL });
  const events = [];
  for await (const next of wrapped) events.push(next);
  assert.strictEqual(events[1], e);
  assert.strictEqual(await wrapped.result(), toolResult);
});

test("manual-recovery failures stop Pi retry policy and preserve the original diagnostic", async () => {
  for (const text of [
    "upstream_server_error: ChatGPT browser stage timed out: multipart_stage_5_acknowledgement",
    "chatgpt_submitted_turn_failed: ChatGPT stopped responding after the task started",
    "502 browser_stream_inconsistent",
    "502 multipart_protocol_violation",
    "502 chatgpt_stopped_thinking",
    "504 codex_tool_timeout: check whether the command is still running",
    "OpenAI Responses stream ended without a stop reason",
  ]) {
    for (const summary of [false, true]) {
      const source = createAssistantMessageEventStream();
      const failed = message("", { stopReason: "error", errorMessage: text });
      source.push({ type: "error", reason: "error", error: failed }); source.end();
      let failure;
      const stream = wrapBridgeStream(source, { model: MODEL, summary, onFailure: f => { failure = f; } });
      const final = await stream.result();
      assert.equal(final.stopReason, "error");
      assert.equal(isRetryableAssistantError(final), false, final.errorMessage);
      assert.equal(failure.message, text);
      assert.ok(["submitted", "unknown"].includes(failure.classification));
      assert.equal(failure.submission, failure.classification === "submitted" ? "SUBMITTED" : "UNKNOWN");
      assert.equal(failure.requestKind, "UNKNOWN");
      assert.equal(failure.recovery, "RECONCILE_BEFORE_REPLAY");
      assert.match(final.errorMessage, /automatic replay is disabled/);
    }
  }
});

test("generic connection loss after SDK stream start stays submission-unknown and cannot replay", async () => {
  for (const summary of [false, true]) {
    const source = createAssistantMessageEventStream();
    source.push({ type: "start", partial: message("") });
    source.push({ type: "error", reason: "error", error: message("", { stopReason: "error", errorMessage: "Connection lost" }) });
    source.end();
    let failure;
    const final = await wrapBridgeStream(source, { model: MODEL, summary, onFailure: f => { failure = f; } }).result();
    assert.match(final.errorMessage, /browser_response_interrupted/);
    assert.equal(isRetryableAssistantError(final), false);
    assert.equal(failure.sdkStreamStarted, "YES");
    assert.equal(failure.submission, "UNKNOWN");
    assert.equal(failure.classification, "unknown");
  }
});

test("pre-submission errors and cancellation keep their original semantics", async () => {
  for (const failed of [
    message("", { stopReason: "error", errorMessage: "ECONNREFUSED connection refused" }),
    message("", { stopReason: "error", errorMessage: "401 ChatGPT sign-in required" }),
    message("", { stopReason: "aborted", errorMessage: "Request was aborted" }),
  ]) {
    const source = createAssistantMessageEventStream();
    source.push({ type: "error", reason: failed.stopReason, error: failed }); source.end();
    const stream = wrapBridgeStream(source, { model: MODEL, summary: true });
    assert.strictEqual(await stream.result(), failed);
  }
});

test("caller cancellation wins over a transport error and does not ask for manual replay", async () => {
  const source = createAssistantMessageEventStream();
  source.push({ type: "error", reason: "error", error: message("", { stopReason: "error", errorMessage: "Connection error." }) });
  source.end();
  const controller = new AbortController(); controller.abort();
  const final = await wrapBridgeStream(source, { model: MODEL, signal: controller.signal }).result();
  assert.equal(final.stopReason, "aborted");
  assert.equal(final.errorMessage, "Request was aborted");
  assert.equal(isRetryableAssistantError(final), false);
});

test("a truncated iterator ends as submission-unknown and never blind-retries", async () => {
  const source = { async *[Symbol.asyncIterator]() { yield { type: "start", partial: message("") }; } };
  let failure;
  const result = await wrapBridgeStream(source, { model: MODEL, onFailure: f => { failure = f; } }).result();
  assert.equal(result.stopReason, "error");
  assert.equal(isRetryableAssistantError(result), false);
  assert.match(result.errorMessage, /incomplete_browser_response/);
  assert.equal(failure.sdkStreamStarted, "YES");
  assert.equal(failure.submission, "UNKNOWN");
  assert.equal(failure.classification, "unknown");
});

test("iterator exceptions and empty sanitized summaries produce terminal errors", async () => {
  const source = { async *[Symbol.asyncIterator]() { throw new Error("transport defect"); } };
  assert.equal((await wrapBridgeStream(source, { model: MODEL }).result()).errorMessage, "transport defect");
  const partialSource = {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: message("") };
      throw new Error("transport defect after start");
    },
  };
  let partialFailure;
  const partialResult = await wrapBridgeStream(partialSource, { model: MODEL, onFailure: f => { partialFailure = f; } }).result();
  assert.match(partialResult.errorMessage, /browser_response_interrupted/);
  assert.equal(partialFailure.submission, "UNKNOWN");
  assert.equal(partialFailure.sdkStreamStarted, "YES");
  const prompt = "history";
  const invalid = sourceFor(message("\nCODEX_LATEST_USER_PROMPT_JSON\n" + JSON.stringify(prompt)));
  const final = await wrapBridgeStream(invalid, { model: MODEL, summary: true, expectedPrompt: () => prompt }).result();
  assert.equal(final.stopReason, "error");
  assert.match(final.errorMessage, /empty summary/);
});

test("terminal guard emits exactly one terminal and drops all post-terminal content/tool events", async () => {
  const final = message("done");
  const lateTool = { type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "late", name: "bash", arguments: { command: "touch late" } }, partial: final };
  const source = {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: { ...final, content: [] } };
      yield { type: "done", reason: "stop", message: final };
      yield { type: "text_delta", contentIndex: 0, delta: "LATE", partial: final };
      yield lateTool;
      yield { type: "error", reason: "error", error: message("", { stopReason: "error", errorMessage: "late error" }) };
    },
  };
  const events = [];
  const wrapped = wrapBridgeStream(source, { model: MODEL });
  for await (const event of wrapped) events.push(event);
  assert.deepEqual(events.map(event => event.type), ["start", "done"]);
  assert.strictEqual(await wrapped.result(), final);
});

test("malformed events and malformed terminal events fail closed without replay", async () => {
  for (const [badEvent, expectedCode] of [
    [{ nope: true }, "browser_stream_malformed_event"],
    [{ type: "done", reason: "stop" }, "browser_stream_malformed_terminal"],
  ]) {
    const source = {
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: message("") };
        yield badEvent;
      },
    };
    let failure;
    const result = await wrapBridgeStream(source, { model: MODEL, onFailure: f => { failure = f; } }).result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, new RegExp(expectedCode));
    assert.equal(isRetryableAssistantError(result), false);
    assert.equal(failure.code, expectedCode);
    assert.equal(failure.submission, "UNKNOWN");
    assert.equal(failure.recovery, "RECONCILE_BEFORE_REPLAY");
  }
});

test("caller cancellation suppresses late deltas and tool calls even when the source ignores abort", async () => {
  const controller = new AbortController();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const partial = message("");
  const source = {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial };
      await gate;
      yield { type: "text_delta", contentIndex: 0, delta: "LATE", partial };
      yield { type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "late", name: "bash", arguments: { command: "touch late" } }, partial };
      yield { type: "done", reason: "stop", message: message("late") };
    },
  };
  const wrapped = wrapBridgeStream(source, { model: MODEL, signal: controller.signal });
  const events = [];
  const collecting = (async () => { for await (const event of wrapped) events.push(event); })();
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  release();
  await collecting;
  const result = await wrapped.result();
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.errorMessage, "Request was aborted");
  assert.equal(events.some(event => event.type === "text_delta" || event.type.startsWith("toolcall_")), false);
  assert.equal(events.filter(event => event.type === "error" || event.type === "done").length, 1);
  assert.equal(isRetryableAssistantError(result), false);
});

test("an ambiguous failure before response headers cannot replay a submitted browser request", async () => {
  for (const text of [
    'chatgpt-web API error (502): {"code":"upstream_server_error","retryable":false}',
    'chatgpt-web API error (504): {"message":"ChatGPT browser request timed out"}',
    "Connection error.",
    "Request timed out.",
    'chatgpt-web API error (429): {"code":"rate_limit_exceeded","retryable":false}',
  ]) {
    for (const summary of [false, true]) {
      const source = createAssistantMessageEventStream();
      source.push({ type: "error", reason: "error", error: message("", { stopReason: "error", errorMessage: text }) });
      source.end();
      let failure;
      const result = await wrapBridgeStream(source, { model: MODEL, summary, onFailure: f => { failure = f; } }).result();
      assert.equal(isRetryableAssistantError(result), false);
      assert.match(result.errorMessage, /browser_request_outcome_unknown/);
      assert.equal(failure.message, text);
      assert.equal(failure.classification, "unknown");
      assert.equal(failure.submission, "UNKNOWN");
      assert.equal(failure.phase, "UNKNOWN");
    }
  }
});
