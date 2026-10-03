import test from "node:test";
import assert from "node:assert/strict";
import { bridgeModelId, checkBridgeStatus, decoratePayload, formatBridgeStatus } from "../extensions/chatgpt-web.js";

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
    turnId: "11111111-1111-4111-8111-111111111111",
    threadId: "22222222-2222-4222-8222-222222222222",
    cwd: "/tmp/workspace",
    bridgeModel: "chatgpt-web/gpt-5.6-sol",
    userItemId: "msg_user_stable",
    environmentItemId: "msg_env_stable"
  });

  assert.equal(output.model, "chatgpt-web/gpt-5.6-sol");
  assert.equal(output.input[1].type, "message");
  assert.equal(output.input[1].role, "user");
  assert.equal(output.input[1].internal_chat_message_metadata_passthrough.turn_id, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(output.input[1].internal_chat_message_metadata_passthrough.content_item_kinds, ["environments.environment_context"]);
  assert.match(output.input[1].content[0].text, /<cwd>\/tmp\/workspace<\/cwd>/);
  assert.match(output.input[1].content[0].text, /<sandbox_mode>danger-full-access<\/sandbox_mode>/);

  assert.equal(output.input[2].type, "message");
  assert.equal(output.input[2].internal_chat_message_metadata_passthrough.turn_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(output.input[2].id, "msg_user_stable");

  const metadata = JSON.parse(output.client_metadata["x-codex-turn-metadata"]);
  assert.equal(metadata.thread_id, "22222222-2222-4222-8222-222222222222");
  assert.equal(metadata.turn_id, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(metadata.workspaces, { "/tmp/workspace": {} });
});


test("checkBridgeStatus uses the bridge health endpoint and reports readiness", async () => {
  const status = await checkBridgeStatus("http://127.0.0.1:17841/v1/", {
    timeoutMs: 50,
    fetchImpl: async (url, init) => {
      assert.equal(url, "http://127.0.0.1:17841/healthz");
      assert.equal(init.method, "GET");
      assert.equal(init.headers.accept, "application/json");
      return new Response(JSON.stringify({
        service: "codex-chatgpt-web",
        status: "ok",
        version: "6.1.4",
        mode: "full",
        accepting_turns: true,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(status.endpoint, "http://127.0.0.1:17841/v1");
  assert.equal(status.reachable, true);
  assert.equal(status.healthy, true);
  assert.equal(status.httpStatus, 200);
  assert.equal(status.mode, "full");
  assert.equal(status.version, "6.1.4");
  assert.equal(status.acceptingTurns, true);
  assert.match(formatBridgeStatus(status), /bridge: ready/);
  assert.match(formatBridgeStatus(status), /version 6\.1\.4/);
  assert.match(formatBridgeStatus(status), /mode full/);
  assert.match(formatBridgeStatus(status), /Accepting turns: yes/);
});

test("checkBridgeStatus rejects an unexpected service on the configured port", async () => {
  const status = await checkBridgeStatus("http://bridge.example/v1", {
    fetchImpl: async () => new Response(JSON.stringify({
      service: "something-else",
      status: "ok",
      accepting_turns: true,
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assert.equal(status.reachable, true);
  assert.equal(status.healthy, false);
  assert.equal(status.acceptingTurns, true);
  assert.match(formatBridgeStatus(status), /bridge: not ready/);
});

test("checkBridgeStatus reports network failure without requiring a live bridge", async () => {
  const status = await checkBridgeStatus(undefined, {
    fetchImpl: async () => { throw new Error("connection refused"); },
  });

  assert.equal(status.reachable, false);
  assert.equal(status.healthy, false);
  assert.equal(status.httpStatus, null);
  assert.equal(status.acceptingTurns, false);
  assert.equal(status.error, "connection refused");
  assert.match(formatBridgeStatus(status), /unreachable \(connection refused\)/);
});

test("keeps item identity stable across provider rounds", () => {
  const turn = {
    turnId: "33333333-3333-4333-8333-333333333333",
    threadId: "44444444-4444-4444-8444-444444444444",
    cwd: "/tmp/project",
    bridgeModel: "chatgpt-web/gpt-5.6-sol",
    userItemId: "msg_user_round_stable",
    environmentItemId: "msg_env_round_stable",
  };
  const request = {
    model: "gpt-5.6-sol",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
  };
  const first = decoratePayload(request, turn);
  const second = decoratePayload(request, turn);
  assert.equal(first.input[0].id, "msg_env_round_stable");
  assert.equal(second.input[0].id, "msg_env_round_stable");
  assert.equal(first.input[1].id, "msg_user_round_stable");
  assert.equal(second.input[1].id, "msg_user_round_stable");
  assert.equal(
    first.client_metadata["x-codex-turn-metadata"],
    second.client_metadata["x-codex-turn-metadata"],
  );
});
