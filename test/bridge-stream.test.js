import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, isRetryableAssistantError, AssistantMessageFrameEncoder, reduceAssistantMessageFrames } from "@earendil-works/pi-ai/compat";
import { stripCompactionAppendix, cleanSummaryMessage, wrapBridgeStream } from "../extensions/bridge-stream.js";

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

test("post-submission failures stop Pi retry policy and preserve the original diagnostic", async () => {
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
      assert.match(final.errorMessage, /automatic replay is disabled/);
    }
  }
});

test("generic connection loss after response start cannot replay an accepted stream", async () => {
  for (const summary of [false, true]) {
    const source = createAssistantMessageEventStream();
    source.push({ type: "start", partial: message("") });
    source.push({ type: "error", reason: "error", error: message("", { stopReason: "error", errorMessage: "Connection lost" }) });
    source.end();
    const final = await wrapBridgeStream(source, { model: MODEL, summary }).result();
    assert.match(final.errorMessage, /browser_response_interrupted/);
    assert.equal(isRetryableAssistantError(final), false);
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

test("a truncated iterator resolves as an inspection-required error rather than hanging", async () => {
  const source = { async *[Symbol.asyncIterator]() { yield { type: "start", partial: message("") }; } };
  const result = await wrapBridgeStream(source, { model: MODEL }).result();
  assert.equal(result.stopReason, "error");
  assert.equal(isRetryableAssistantError(result), false);
  assert.match(result.errorMessage, /incomplete_browser_response/);
});

test("iterator exceptions and empty sanitized summaries produce terminal errors", async () => {
  const source = { async *[Symbol.asyncIterator]() { throw new Error("transport defect"); } };
  assert.equal((await wrapBridgeStream(source, { model: MODEL }).result()).errorMessage, "transport defect");
  const prompt = "history";
  const invalid = sourceFor(message("\nCODEX_LATEST_USER_PROMPT_JSON\n" + JSON.stringify(prompt)));
  const final = await wrapBridgeStream(invalid, { model: MODEL, summary: true, expectedPrompt: () => prompt }).result();
  assert.equal(final.stopReason, "error");
  assert.match(final.errorMessage, /empty summary/);
});
