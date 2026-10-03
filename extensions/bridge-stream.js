import { createAssistantMessageEventStream, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";

const PROMPT_MARKER = "\nCODEX_LATEST_USER_PROMPT_JSON\n";

// Only remove the bridge's canonical appendix, never an arbitrary marker in prose.
export function stripCompactionAppendix(text, expectedPrompt) {
  if (typeof expectedPrompt !== "string") return text;
  const offset = text.lastIndexOf(PROMPT_MARKER);
  if (offset < 0) return text;
  try {
    if (JSON.parse(text.slice(offset + PROMPT_MARKER.length).trim()) !== expectedPrompt) return text;
  } catch {
    return text;
  }
  return text.slice(0, offset).trimEnd();
}

export function cleanSummaryMessage(message, expectedPrompt) {
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  const cleaned = stripCompactionAppendix(text, expectedPrompt);
  if (cleaned === text) return message;
  if (!cleaned.trim()) throw new Error("ChatGPT Web returned an empty summary after removing its control appendix");
  let remaining = cleaned.length;
  const content = [];
  for (const block of message.content) {
    if (block.type !== "text") {
      content.push(block);
      continue;
    }
    const nextText = block.text.slice(0, remaining);
    remaining -= nextText.length;
    if (!nextText) continue;
    if (nextText === block.text) content.push(block);
    else {
      const { textSignature: _signature, ...rest } = block;
      content.push({ ...rest, text: nextText });
    }
  }
  return { ...message, content };
}

export function manualRecoveryCode(message) {
  const text = message?.errorMessage || "";
  return text.match(/multipart_stage_\d+_acknowledgement/)?.[0]
    || (text.includes("codex_tool_timeout") ? "tool_result_not_observed" : null)
    || text.match(/chatgpt_submitted_turn_failed|chatgpt_stopped_thinking|browser_stream_inconsistent|multipart_protocol_violation/)?.[0]
    || (/(stream ended before|ended without).*(terminal|response|message_stop|stop reason)/i.test(text) ? "incomplete_browser_response" : null);
}

function errorMessage(model, partial, error, signal) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
    ...partial,
    stopReason: signal?.aborted ? "aborted" : "error",
    errorMessage: signal?.aborted ? "Request was aborted" : (error?.message || String(error)),
  };
}

function replaySummary(stream, message) {
  const partial = { ...message, content: [], stopReason: "pending" };
  stream.push({ type: "start", partial });
  for (const block of message.content) {
    const contentIndex = partial.content.length;
    if (block.type === "text" || block.type === "thinking") {
      const kind = block.type;
      const field = kind === "text" ? "text" : "thinking";
      const redacted = kind === "thinking" && block.redacted;
      const live = { ...block, [field]: redacted ? block[field] : "" };
      partial.content.push(live);
      stream.push({ type: kind + "_start", contentIndex, partial });
      live[field] = block[field];
      if (!redacted) stream.push({ type: kind + "_delta", contentIndex, delta: block[field], partial });
      stream.push({ type: kind + "_end", contentIndex, content: block[field], partial });
    } else {
      throw new Error("ChatGPT Web summary unexpectedly returned a non-text tool block");
    }
  }
  Object.assign(partial, message);
  stream.push({ type: "done", reason: message.stopReason, message });
}

// Normal turns retain incremental events. Summaries are buffered until their canonical
// trailer can be validated; no unsanitized text delta or durable result reaches Pi.
export function wrapBridgeStream(source, {
  model, summary = false, expectedPrompt = () => undefined, signal, onFailure = () => {},
} = {}) {
  const output = createAssistantMessageEventStream();
  void (async () => {
    let partial;
    let terminal = false;
    let responseStarted = false;
    const fail = (message) => {
      if (signal?.aborted && message.stopReason !== "aborted") {
        message = { ...message, stopReason: "aborted", errorMessage: "Request was aborted" };
      }
      const code = message.stopReason === "aborted" ? null : (manualRecoveryCode(message)
        || (isRetryableAssistantError(message)
          && !/\bECONNREFUSED\b|connection refused/i.test(message.errorMessage || "")
          ? (responseStarted ? "browser_response_interrupted" : "browser_request_outcome_unknown") : null));
      onFailure({ code, message: message.errorMessage, at: new Date().toISOString() });
      const next = code ? {
        ...message,
        // Pi currently classifies retryability from error text, ignoring bridge retryable.
        // Keep transport details in /chatgpt-web-status, outside that classifier.
        errorMessage: `ChatGPT Web needs manual recovery (${code}). The request may already have been submitted. Inspect the ChatGPT tab before continuing; automatic replay is disabled. Details: /chatgpt-web-status.`,
      } : message;
      output.push({ type: "error", reason: next.stopReason === "aborted" ? "aborted" : "error", error: next });
    };
    try {
      for await (const event of source) {
        partial = event.partial || partial;
        if (event.type === "start") responseStarted = true;
        if (event.type === "error") {
          terminal = true;
          fail(event.error);
        } else if (event.type === "done") {
          terminal = true;
          if (summary) replaySummary(output, cleanSummaryMessage(event.message, expectedPrompt()));
          else output.push(event);
        } else if (!summary) output.push(event);
      }
      if (!terminal) {
        fail(errorMessage(model, partial, new Error("Stream ended before a terminal response event"), signal));
      }
    } catch (error) {
      fail(errorMessage(model, partial, error, signal));
    } finally {
      output.end();
    }
  })();
  return output;
}
