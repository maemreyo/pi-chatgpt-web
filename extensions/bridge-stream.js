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

function observedPhase(code, streamStarted) {
  if (code?.startsWith("multipart_stage_")) return code;
  if (code === "chatgpt_submitted_turn_failed") return "submitted_turn";
  if (code === "chatgpt_stopped_thinking") return "thinking";
  if (code === "tool_result_not_observed") return "tool_result_wait";
  if (code === "multipart_protocol_violation") return "multipart_protocol";
  if (code === "browser_stream_malformed_event") return "stream_validation";
  if (code === "browser_stream_malformed_terminal") return "terminal_validation";
  if (streamStarted) return "response_stream";
  return "UNKNOWN";
}

function hasExplicitSubmittedEvidence(code) {
  return code === "chatgpt_submitted_turn_failed"
    || code === "chatgpt_stopped_thinking"
    || code === "tool_result_not_observed";
}

export function createFailureObservation(message, {
  code = null,
  streamStarted = false,
  diagnosticContext = {},
  at = new Date().toISOString(),
} = {}) {
  const aborted = message?.stopReason === "aborted";
  const classification = aborted || !code
    ? "error"
    : (hasExplicitSubmittedEvidence(code) ? "submitted" : "unknown");
  const submission = classification === "submitted" ? "SUBMITTED" : "UNKNOWN";
  const correlationThreadId = diagnosticContext.correlationThreadId || "UNKNOWN";
  const correlationTurnId = diagnosticContext.correlationTurnId || "UNKNOWN";
  const correlationProvenance = (correlationThreadId !== "UNKNOWN" || correlationTurnId !== "UNKNOWN")
    ? (diagnosticContext.correlationProvenance || "pi-provider-generated")
    : "UNKNOWN";
  return {
    at,
    classification,
    code: code || "UNKNOWN",
    submission,
    phase: observedPhase(code, streamStarted),
    sdkStreamStarted: streamStarted ? "YES" : "NO",
    requestKind: diagnosticContext.requestKind || "UNKNOWN",
    correlationThreadId,
    correlationTurnId,
    correlationProvenance,
    upstreamThreadId: diagnosticContext.upstreamThreadId || "UNKNOWN",
    upstreamTurnId: diagnosticContext.upstreamTurnId || "UNKNOWN",
    upstreamIdentityProvenance: diagnosticContext.upstreamIdentityProvenance || "UNKNOWN",
    message: message?.errorMessage || "UNKNOWN",
    recovery: code ? "RECONCILE_BEFORE_REPLAY" : "STANDARD_ERROR_HANDLING",
  };
}

export function formatFailureObservation(observation) {
  if (!observation) return "Last provider observation: none";
  const lines = [
    `Last provider observation (${observation.at || "UNKNOWN"}):`,
    `Classification: ${observation.classification || "UNKNOWN"}`,
    `Submission: ${observation.submission || "UNKNOWN"}`,
    `Observed phase: ${observation.phase || "UNKNOWN"}`,
    `SDK stream started: ${observation.sdkStreamStarted || "UNKNOWN"} (not submission evidence)`,
    `Request kind: ${observation.requestKind || "UNKNOWN"}`,
    `Requested correlation identity: thread=${observation.correlationThreadId || "UNKNOWN"}, turn=${observation.correlationTurnId || "UNKNOWN"} (${observation.correlationProvenance || "UNKNOWN"})`,
    `Observed upstream identity: thread=${observation.upstreamThreadId || "UNKNOWN"}, turn=${observation.upstreamTurnId || "UNKNOWN"} (${observation.upstreamIdentityProvenance || "UNKNOWN"})`,
    `Diagnostic code: ${observation.code || "UNKNOWN"}`,
    `Original error: ${observation.message || "UNKNOWN"}`,
  ];
  if (observation.recovery === "RECONCILE_BEFORE_REPLAY") {
    lines.push("Recovery: reconcile ChatGPT browser state/receipts before any replay; never automatically replay a possibly mutating request.");
  }
  return lines.join("\n");
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
  diagnosticContext = {},
} = {}) {
  const output = createAssistantMessageEventStream();
  void (async () => {
    let partial;
    let terminal = false;
    let streamStarted = false;
    const fail = (message, explicitCode = null, inferInterrupted = true) => {
      if (terminal) return;
      if (signal?.aborted && message.stopReason !== "aborted") {
        message = { ...message, stopReason: "aborted", errorMessage: "Request was aborted" };
      }
      const code = message.stopReason === "aborted" ? null : (explicitCode || manualRecoveryCode(message)
        || (inferInterrupted && streamStarted ? "browser_response_interrupted" : null)
        || (isRetryableAssistantError(message)
          && !/\bECONNREFUSED\b|connection refused/i.test(message.errorMessage || "")
          ? "browser_request_outcome_unknown" : null));
      const observation = createFailureObservation(message, {
        code,
        streamStarted,
        diagnosticContext,
      });
      onFailure(observation);
      const next = code ? {
        ...message,
        // Pi currently classifies retryability from error text, ignoring bridge retryable.
        // Keep transport details in /chatgpt-web-status, outside that classifier.
        errorMessage: `ChatGPT Web needs manual recovery (${code}). Reconcile ChatGPT browser state before any replay; automatic replay is disabled. Details: /chatgpt-web-status.`,
      } : message;
      terminal = true;
      output.push({ type: "error", reason: next.stopReason === "aborted" ? "aborted" : "error", error: next });
    };
    try {
      if (signal?.aborted) {
        fail(errorMessage(model, partial, new Error("Request was aborted"), signal));
      } else {
        for await (const event of source) {
          if (terminal) break;
          if (signal?.aborted) {
            fail(errorMessage(model, partial, new Error("Request was aborted"), signal));
            break;
          }
          if (!event || typeof event !== "object" || typeof event.type !== "string") {
            fail(errorMessage(model, partial, new Error("Malformed ChatGPT Web stream event"), signal), "browser_stream_malformed_event");
            break;
          }
          partial = event.partial || partial;
          if (event.type === "start") {
            if (streamStarted) {
              fail(errorMessage(model, partial, new Error("Duplicate ChatGPT Web stream start event"), signal), "browser_stream_malformed_event");
              break;
            }
            streamStarted = true;
            if (!summary) output.push(event);
            continue;
          }
          if (event.type === "error") {
            if (!event.error || typeof event.error !== "object") {
              fail(errorMessage(model, partial, new Error("Malformed ChatGPT Web error terminal event"), signal), "browser_stream_malformed_terminal");
            } else {
              fail(event.error);
            }
            break;
          }
          if (event.type === "done") {
            if (!event.message || typeof event.message !== "object"
              || typeof event.message.stopReason !== "string" || event.message.stopReason === "pending") {
              fail(errorMessage(model, partial, new Error("Malformed ChatGPT Web done terminal event"), signal), "browser_stream_malformed_terminal");
              break;
            }
            if (summary) {
              try {
                replaySummary(output, cleanSummaryMessage(event.message, expectedPrompt()));
                terminal = true;
              } catch (error) {
                fail(errorMessage(model, partial, error, signal), null, false);
              }
            } else {
              terminal = true;
              output.push(event);
            }
            break;
          }
          if (!streamStarted) {
            fail(errorMessage(model, partial, new Error("ChatGPT Web content event arrived before stream start"), signal), "browser_stream_malformed_event");
            break;
          }
          if (!summary) output.push(event);
        }
      }
      if (!terminal) {
        fail(errorMessage(model, partial, new Error("Stream ended before a terminal response event"), signal));
      }
    } catch (error) {
      if (!terminal) fail(errorMessage(model, partial, error, signal));
    } finally {
      output.end();
    }
  })();
  return output;
}
