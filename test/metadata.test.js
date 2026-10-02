import test from "node:test";
import assert from "node:assert/strict";
import { bridgeModelId, decoratePayload } from "../extensions/chatgpt-web.js";

test("bridgeModelId prefixes public Pi model IDs", () => {
  assert.equal(bridgeModelId("gpt-5.6-sol"), "chatgpt-web/gpt-5.6-sol");
  assert.equal(bridgeModelId("chatgpt-web/gpt-5.6-sol"), "chatgpt-web/gpt-5.6-sol");
});

test("decoratePayload adds Codex turn metadata to the current user message", () => {
  const output = decoratePayload({
    model: "gpt-5.6-sol",
    input: [
      { role: "system", content: "system" },
      { role: "user", content: [{ type: "input_text", text: "hello" }] }
    ]
  }, {
    turnId: "turn_test",
    threadId: "thread_test",
    cwd: "/tmp/workspace",
    bridgeModel: "chatgpt-web/gpt-5.6-sol"
  });

  assert.equal(output.model, "chatgpt-web/gpt-5.6-sol");
  assert.equal(output.input[1].type, "message");
  assert.equal(output.input[1].internal_chat_message_metadata_passthrough.turn_id, "turn_test");
  assert.match(output.input[1].id, /^msg_/);

  const metadata = JSON.parse(output.client_metadata["x-codex-turn-metadata"]);
  assert.equal(metadata.thread_id, "thread_test");
  assert.equal(metadata.turn_id, "turn_test");
  assert.deepEqual(metadata.workspaces, { "/tmp/workspace": {} });
});
