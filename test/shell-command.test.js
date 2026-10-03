import test from "node:test";
import assert from "node:assert/strict";
import chatGptWebExtension, {
  createShellCommandTool,
  executeShellCommand,
  guardShellCommandTools,
  shellCommandToBashArgs,
} from "../extensions/chatgpt-web.js";

test("shellCommandToBashArgs maps command and timeout milliseconds to Pi bash seconds", () => {
  assert.deepEqual(
    shellCommandToBashArgs({ command: "printf ok", timeout_ms: 2500 }),
    { command: "printf ok", timeout: 2.5 },
  );
  assert.deepEqual(shellCommandToBashArgs({ command: "pwd" }), { command: "pwd" });
});

test("shellCommandToBashArgs maps workdir without bypassing Pi bash", () => {
  assert.deepEqual(
    shellCommandToBashArgs({ command: "pwd", workdir: "/tmp/a b/it's-here" }),
    { command: "cd -- '/tmp/a b/it'\"'\"'s-here' && pwd" },
  );
});

test("executeShellCommand delegates through ctx.executeTool and preserves successful result", async () => {
  const nestedResult = {
    content: [{ type: "text", text: "ok" }],
    details: { source: "bash" },
    structuredContent: { output: "ok", exit_code: 0 },
  };
  const signal = new AbortController().signal;
  const onUpdate = () => {};
  let observed;
  const ctx = {
    tools: [{ name: "bash" }],
    async executeTool(name, args, options) {
      observed = { name, args, options };
      return { toolCall: { name }, result: nestedResult, isError: false };
    },
  };

  const result = await executeShellCommand(
    { command: "printf ok", timeout_ms: 1500 },
    signal,
    onUpdate,
    ctx,
  );

  assert.strictEqual(result, nestedResult);
  assert.equal(observed.name, "bash");
  assert.deepEqual(observed.args, { command: "printf ok", timeout: 1.5 });
  assert.strictEqual(observed.options.signal, signal);
  assert.strictEqual(observed.options.onUpdate, onUpdate);
});

test("executeShellCommand propagates nested tool error state and thrown errors", async () => {
  const ctxWithErrorResult = {
    tools: [{ name: "bash" }],
    async executeTool() {
      return {
        toolCall: { name: "bash" },
        result: { content: [{ type: "text", text: "denied" }], details: undefined },
        isError: true,
      };
    },
  };
  const result = await executeShellCommand({ command: "false" }, undefined, undefined, ctxWithErrorResult);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "denied");

  const ctxThatThrows = {
    tools: [{ name: "bash" }],
    async executeTool() {
      throw new Error("nested execution failed");
    },
  };
  await assert.rejects(
    executeShellCommand({ command: "false" }, undefined, undefined, ctxThatThrows),
    /nested execution failed/,
  );
});

test("executeShellCommand refuses to create authority when Pi bash is unavailable", async () => {
  let called = false;
  await assert.rejects(
    executeShellCommand({ command: "pwd" }, undefined, undefined, {
      tools: [{ name: "read" }],
      async executeTool() {
        called = true;
      },
    }),
    /bash tool is unavailable/,
  );
  assert.equal(called, false);
});

test("shell_command loadout is hidden when bash is not callable", () => {
  const tool = createShellCommandTool();
  assert.deepEqual(
    tool.prepareLoadout({ callable: [{ name: "read" }] }),
    { hiddenDeclarations: ["shell_command"] },
  );
  assert.equal(tool.prepareLoadout({ callable: [{ name: "bash" }] }), undefined);
});

test("guardShellCommandTools strips compatibility alias from a bash-less provider request", () => {
  const shellOnly = {
    model: "gpt-5.6-sol",
    tools: [
      { type: "function", name: "read" },
      { type: "function", name: "shell_command" },
    ],
  };
  const guarded = guardShellCommandTools(shellOnly);
  assert.deepEqual(guarded.tools.map((tool) => tool.name), ["read"]);
  assert.deepEqual(shellOnly.tools.map((tool) => tool.name), ["read", "shell_command"]);

  const withBash = {
    tools: [
      { type: "function", name: "bash" },
      { type: "function", name: "shell_command" },
    ],
  };
  assert.strictEqual(guardShellCommandTools(withBash), withBash);

  const controlOnly = { model: "gpt-5.6-sol", input: [] };
  assert.strictEqual(guardShellCommandTools(controlOnly), controlOnly);
});

function makeFakePi({ hasBash = true } = {}) {
  const handlers = new Map();
  const registeredTools = [];
  let activeTools = hasBash ? ["bash", "read", "write", "edit"] : ["read", "write", "edit"];
  const allTools = hasBash ? [{ name: "bash" }, { name: "read" }] : [{ name: "read" }];

  return {
    handlers,
    registeredTools,
    get activeTools() {
      return activeTools;
    },
    api: {
      registerCommand() {},
      registerProvider() {},
      registerTool(tool) {
        registeredTools.push(tool);
        allTools.push({ name: tool.name });
      },
      on(name, handler) {
        handlers.set(name, handler);
        return () => {};
      },
      getAllTools() {
        return [...allTools];
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

test("extension registers and activates shell_command only for chatgpt-web turns with active bash", async () => {
  const fake = makeFakePi();
  chatGptWebExtension(fake.api);

  await fake.handlers.get("session_start")({}, { model: { provider: "chatgpt-web" } });
  assert.deepEqual(fake.registeredTools.map((tool) => tool.name), ["shell_command"]);
  assert.equal(fake.activeTools.includes("shell_command"), true);

  await fake.handlers.get("before_agent_start")({}, { model: { provider: "other" } });
  assert.equal(fake.activeTools.includes("shell_command"), false);

  await fake.handlers.get("before_agent_start")({}, { model: { provider: "chatgpt-web" } });
  assert.equal(fake.activeTools.includes("shell_command"), true);
  assert.equal(fake.registeredTools.length, 1);
});

test("extension does not register shell_command when Pi has no bash tool", async () => {
  const fake = makeFakePi({ hasBash: false });
  chatGptWebExtension(fake.api);

  await fake.handlers.get("session_start")({}, { model: { provider: "chatgpt-web" } });
  assert.deepEqual(fake.registeredTools, []);
  assert.equal(fake.activeTools.includes("shell_command"), false);
});
