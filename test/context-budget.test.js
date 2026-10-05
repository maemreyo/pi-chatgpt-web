import test from "node:test";
import assert from "node:assert/strict";
import {
  BRIDGE_POLICY_VERSION,
  applyPiCompactionSettings,
  createFallbackBudgetState,
  PI_DEFAULT_RESERVE_TOKENS,
  computePiBudget,
  formatContextBudgetStatus,
  resolveBridgeContextBudgets,
  resolveKnownBridgeBudget,
} from "../extensions/context-budget.js";
import { createChatGptWebExtension } from "../extensions/chatgpt-web.js";

const HEALTH = Object.freeze({
  endpoint: "http://127.0.0.1:17841/v1",
  reachable: true,
  healthy: true,
  httpStatus: 200,
  mode: "full",
  version: BRIDGE_POLICY_VERSION,
  acceptingTurns: true,
});

function capabilities(overrides = {}) {
  return {
    solAvailable: true,
    proAvailable: false,
    extraHighAvailable: false,
    experimentalBiggerContext: false,
    ...overrides,
  };
}

function configSnapshot(overrides = {}) {
  return JSON.stringify({
    version: 3,
    releaseVersion: BRIDGE_POLICY_VERSION,
    host: "127.0.0.1",
    port: 17841,
    mode: "full",
    ...capabilities(),
    ...overrides,
  });
}

function regularFileStat(size = 1024) {
  return { isFile: () => true, size };
}

function verifiedState(effort, caps) {
  const instant = resolveKnownBridgeBudget("gpt-5.6-sol-instant", "low", caps);
  const sol = resolveKnownBridgeBudget("gpt-5.6-sol", effort, caps);
  assert.equal(instant.supported, true);
  assert.equal(sol.supported, true);
  return {
    verified: true,
    source: "test-policy",
    reason: null,
    baseUrl: "http://127.0.0.1:17841/v1",
    healthStatus: HEALTH,
    effort,
    capabilities: caps,
    models: {
      "gpt-5.6-sol-instant": instant.budget,
      "gpt-5.6-sol": sol.budget,
    },
  };
}

test("Pi usable window keeps default compaction at or before bridge auto-compact", () => {
  const bigger = computePiBudget(270000, 240000);
  assert.equal(bigger.piContextWindow, 256384);
  assert.equal(bigger.piCompactionThreshold, 240000);
  const base = computePiBudget(90000, 80000);
  assert.equal(base.piContextWindow, 90000);
  assert.equal(base.piCompactionThreshold, 73616);
});

test("known 6.1.4 budgets distinguish Plus Low/Medium/High x3 and Pro", () => {
  const plusX3 = capabilities({ experimentalBiggerContext: true });

  for (const effort of ["medium", "high"]) {
    const result = resolveKnownBridgeBudget("gpt-5.6-sol", effort, plusX3);
    assert.equal(result.supported, true);
    assert.equal(result.budget.bridgeContextWindow, 270000);
    assert.equal(result.budget.bridgeAutoCompactTokenLimit, 240000);
    assert.equal(result.budget.piContextWindow, 256384);
    assert.equal(result.budget.defaultPiCompactionThreshold, 240000);
  }

  const low = resolveKnownBridgeBudget("gpt-5.6-sol", "low", plusX3);
  assert.equal(low.budget.bridgeContextWindow, 123000);
  assert.equal(low.budget.bridgeAutoCompactTokenLimit, 96000);
  assert.equal(low.budget.piContextWindow, 112384);
  assert.equal(low.budget.defaultPiCompactionThreshold, 96000);

  const instant = resolveKnownBridgeBudget("gpt-5.6-sol-instant", "high", plusX3);
  assert.equal(instant.budget.effort, "low");
  assert.equal(instant.budget.piContextWindow, 112384);

  const pro = resolveKnownBridgeBudget("gpt-5.6-sol", "max", capabilities({
    proAvailable: true,
  }));
  assert.equal(pro.supported, true);
  assert.equal(pro.budget.bridgeContextWindow, 112193);
  assert.equal(pro.budget.bridgeAutoCompactTokenLimit, 95000);
  assert.equal(pro.budget.piContextWindow, 111384);
  assert.equal(pro.budget.defaultPiCompactionThreshold, 95000);
});

test("default local bridge derives verified x3 metadata only from matching bounded config", async () => {
  const state = await resolveBridgeContextBudgets({
    healthStatus: HEALTH,
    effort: "high",
    statImpl: async () => regularFileStat(),
    readFileImpl: async () => configSnapshot({ experimentalBiggerContext: true }),
  });

  assert.equal(state.verified, true);
  assert.match(state.source, /bridge-health\+local-config-policy-6\.1\.4/);
  assert.equal(state.models["gpt-5.6-sol"].bridgeContextWindow, 270000);
  assert.equal(state.models["gpt-5.6-sol"].piContextWindow, 256384);
});

test("custom or remote bridge never consumes default local config", async () => {
  let touchedLocalConfig = false;
  const state = await resolveBridgeContextBudgets({
    baseUrl: "https://bridge.example/v1",
    healthStatus: { ...HEALTH, endpoint: "https://bridge.example/v1" },
    effort: "high",
    statImpl: async () => {
      touchedLocalConfig = true;
      return regularFileStat();
    },
    readFileImpl: async () => {
      touchedLocalConfig = true;
      return configSnapshot({ experimentalBiggerContext: true });
    },
  });

  assert.equal(touchedLocalConfig, false);
  assert.equal(state.verified, false);
  assert.equal(state.models["gpt-5.6-sol"].piContextWindow, 90000);
  assert.match(state.reason, /custom\/remote bridge URL/);
});

test("version mismatch and malformed config fail closed to conservative windows", async () => {
  const mismatch = await resolveBridgeContextBudgets({
    healthStatus: { ...HEALTH, version: "6.1.5" },
    effort: "high",
    statImpl: async () => regularFileStat(),
    readFileImpl: async () => configSnapshot({ releaseVersion: "6.1.5" }),
  });
  assert.equal(mismatch.verified, false);
  assert.equal(mismatch.models["gpt-5.6-sol"].piContextWindow, 90000);

  const malformed = await resolveBridgeContextBudgets({
    healthStatus: HEALTH,
    effort: "high",
    statImpl: async () => regularFileStat(),
    readFileImpl: async () => "{not-json",
  });
  assert.equal(malformed.verified, false);
  assert.equal(malformed.models["gpt-5.6-sol"].piContextWindow, 90000);
  assert.match(malformed.reason, /malformed JSON/);
});

test("budget status separates raw bridge, Pi usable window, threshold, and provenance", async () => {
  const state = await resolveBridgeContextBudgets({
    healthStatus: HEALTH,
    effort: "high",
    statImpl: async () => regularFileStat(),
    readFileImpl: async () => configSnapshot({ experimentalBiggerContext: true }),
  });
  const output = formatContextBudgetStatus(applyPiCompactionSettings(state, {}));

  assert.match(output, /Context budget: verified/);
  assert.match(output, /Budget source:/);
  assert.match(output, /Bridge raw context: 270,000/);
  assert.match(output, /Bridge auto-compact limit: 240,000/);
  assert.match(output, /Pi advertised context: 256,384/);
  assert.match(output, /Effective safe compaction threshold: 240,000/);
  assert.match(output, /Pi effective reserve: 16,384/);
});

function makeDynamicPi() {
  const handlers = new Map();
  const providers = new Map();
  const commands = new Map();
  const modelRegistry = new Map();
  const tools = [{ name: "bash" }, { name: "read" }];
  let activeTools = tools.map((tool) => tool.name);
  let thinkingLevel = "high";
  let currentModel;
  const setModelCalls = [];

  const api = {
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerProvider(id, config) {
      providers.set(id, config);
      for (const model of config.models || []) {
        modelRegistry.set(`${id}/${model.id}`, { ...model, provider: id });
      }
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
    getSettings() { return {}; },
    getThinkingLevel() { return thinkingLevel; },
    setThinkingLevel(level) { thinkingLevel = level; },
    async setModel(model) {
      setModelCalls.push(model);
      currentModel = model;
      return true;
    },
  };

  const ctx = {
    cwd: "/tmp/pi-context-budget-test",
    isIdle: () => true,
    sessionManager: { getSessionId: () => "11111111-1111-7111-8111-111111111111" },
    modelRegistry: {
      find(provider, id) {
        return modelRegistry.get(`${provider}/${id}`);
      },
    },
    ui: { notify() {} },
  };
  Object.defineProperty(ctx, "model", { get: () => currentModel });

  return {
    api,
    ctx,
    handlers,
    providers,
    commands,
    setModelCalls,
    selectInitial(id = "gpt-5.6-sol") {
      currentModel = modelRegistry.get(`chatgpt-web/${id}`);
      assert.ok(currentModel);
      return currentModel;
    },
    setThinkingLevel(level) {
      thinkingLevel = level;
    },
    currentModel: () => currentModel,
  };
}

test("active model metadata refreshes on experiment and effort shrink without stale larger object", async () => {
  let biggerContext = true;
  const fake = makeDynamicPi();
  const statusChecker = async () => HEALTH;
  const budgetResolver = async ({ effort }) => verifiedState(
    effort,
    capabilities({ experimentalBiggerContext: biggerContext }),
  );

  createChatGptWebExtension({ statusChecker, budgetResolver })(fake.api);
  const initial = fake.selectInitial();
  assert.equal(initial.contextWindow, 90000);

  await fake.handlers.get("session_start")({}, fake.ctx);
  assert.equal(fake.currentModel().contextWindow, 256384);

  biggerContext = false;
  await fake.handlers.get("before_agent_start")({}, fake.ctx);
  assert.equal(fake.currentModel().contextWindow, 90000);

  biggerContext = true;
  fake.setThinkingLevel("high");
  await fake.handlers.get("before_agent_start")({}, fake.ctx);
  assert.equal(fake.currentModel().contextWindow, 256384);

  fake.setThinkingLevel("low");
  await fake.handlers.get("thinking_level_select")(
    { level: "low", previousLevel: "high" },
    fake.ctx,
  );
  assert.equal(fake.currentModel().contextWindow, 112384);
  assert.ok(fake.setModelCalls.length >= 4);
});


test("effective reserves and model overrides cap Pi without mutating settings", () => {
  const state = verifiedState("high", capabilities({ experimentalBiggerContext: true }));
  const zero = { compaction: { reserveTokens: 0 } };
  const before = JSON.stringify(zero);
  const z = applyPiCompactionSettings(state, zero).models["gpt-5.6-sol"];
  assert.equal(z.piContextWindow, 240000);
  assert.equal(z.piCompactionThreshold, 240000);
  assert.equal(JSON.stringify(zero), before);
  const strict = { compaction: { reserveTokens: 40000 } };
  const strictState = applyPiCompactionSettings(state, strict);
  assert.equal(strictState.models["gpt-5.6-sol"].piContextWindow, 256384);
  assert.equal(strictState.models["gpt-5.6-sol"].piCompactionThreshold, 216384);
  assert.match(formatContextBudgetStatus(strictState), /threshold: 216,384/);
  const overridden = applyPiCompactionSettings(state, {
    compaction: { reserveTokens: 0, modelOverrides: { "chatgpt-web/gpt-5.6-sol": { reserveTokens: 40000 } } },
  });
  assert.equal(overridden.models["gpt-5.6-sol"].piReserveTokens, 40000);
  assert.equal(overridden.models["gpt-5.6-sol"].piCompactionThreshold, 216384);
  assert.equal(overridden.models["gpt-5.6-sol-instant"].piReserveTokens, 0);
});

test("disabled, unavailable and invalid policies are diagnosed conservatively", () => {
  const state = verifiedState("high", capabilities({ experimentalBiggerContext: true }));
  const settings = { compaction: { enabled: false } };
  const disabled = applyPiCompactionSettings(state, settings);
  assert.equal(disabled.models["gpt-5.6-sol"].piCompactionThreshold, null);
  assert.match(formatContextBudgetStatus(disabled), /automatic compaction: disabled/);
  assert.equal(settings.compaction.enabled, false);
  const unknown = applyPiCompactionSettings(state, undefined, "API unavailable");
  assert.equal(unknown.models["gpt-5.6-sol"].piContextWindow, 240000);
  assert.equal(unknown.models["gpt-5.6-sol"].piCompactionThreshold, null);
  assert.match(formatContextBudgetStatus(unknown), /policy fallback reason: API unavailable/);
  const invalid = applyPiCompactionSettings(state, { compaction: { reserveTokens: -1 } });
  assert.equal(invalid.models["gpt-5.6-sol"].piCompactionPolicyKnown, false);
  const fallback = applyPiCompactionSettings(createFallbackBudgetState({ reason: "remote URL" }), { compaction: { reserveTokens: 0 } });
  assert.equal(fallback.models["gpt-5.6-sol"].piContextWindow, 73616);
  assert.match(formatContextBudgetStatus(fallback), /Budget fallback reason: remote URL/);
});

test("idle input refreshes before pre-turn compaction while streamed input leaves the model alone", async () => {
  let bigger = true;
  let settings = {};
  const fake = makeDynamicPi();
  fake.api.getSettings = () => settings;
  createChatGptWebExtension({
    statusChecker: async () => HEALTH,
    budgetResolver: async ({ effort }) => verifiedState(effort, capabilities({ experimentalBiggerContext: bigger })),
  })(fake.api);
  fake.selectInitial();
  await fake.handlers.get("session_start")({}, fake.ctx);
  assert.equal(fake.currentModel().contextWindow, 256384);
  bigger = false;
  assert.deepEqual(await fake.handlers.get("input")({ source: "interactive", text: "unchanged" }, fake.ctx), { action: "continue" });
  assert.equal(fake.currentModel().contextWindow, 90000);
  bigger = true;
  settings = { compaction: { reserveTokens: 0 } };
  await fake.handlers.get("input")({ source: "rpc" }, fake.ctx);
  assert.equal(fake.currentModel().contextWindow, 240000);
  fake.ctx.isIdle = () => false;
  bigger = false;
  const current = fake.currentModel();
  await fake.handlers.get("input")({ source: "rpc" }, fake.ctx);
  assert.equal(fake.currentModel(), current);
  fake.ctx.isIdle = () => true;
  await fake.handlers.get("input")({ source: "extension" }, fake.ctx);
  assert.equal(fake.currentModel(), current);
});

test("rebind preserves thinking and stale larger models cannot send requests", async () => {
  let bigger = true;
  const fake = makeDynamicPi();
  createChatGptWebExtension({
    statusChecker: async () => HEALTH,
    budgetResolver: async ({ effort }) => verifiedState(effort, capabilities({ experimentalBiggerContext: bigger })),
  })(fake.api);
  fake.selectInitial();
  const setModel = fake.api.setModel;
  fake.api.setModel = async (model) => {
    await setModel(model);
    fake.setThinkingLevel("medium");
    await fake.handlers.get("thinking_level_select")({ level: "medium" }, fake.ctx);
    return true;
  };
  await fake.handlers.get("session_start")({}, fake.ctx);
  assert.equal(fake.api.getThinkingLevel(), "high");
  fake.api.setModel = async () => false;
  bigger = false;
  await assert.rejects(fake.handlers.get("input")({ source: "rpc" }, fake.ctx), /Could not safely shrink/);
  assert.throws(() => fake.providers.get("chatgpt-web").streamSimple(fake.currentModel(), { messages: [] }), /active model budget is stale/);
});

test("metadata failures, oversize and unsupported account capabilities use conservative budgets", async () => {
  for (const args of [
    { healthStatus: { ...HEALTH, acceptingTurns: false } },
    { healthStatus: HEALTH, statImpl: async () => regularFileStat(100000) },
    { healthStatus: HEALTH, statImpl: async () => regularFileStat(), readFileImpl: async () => configSnapshot({ solAvailable: false }) },
    { healthStatus: HEALTH, statImpl: async () => regularFileStat(), readFileImpl: async () => configSnapshot({ experimentalBiggerContext: "true" }) },
  ]) {
    const state = await resolveBridgeContextBudgets({ effort: "high", ...args });
    assert.equal(state.verified, false);
    assert.equal(state.models["gpt-5.6-sol"].piContextWindow, 90000);
    assert.ok(state.reason);
  }
});

test("stalled metadata resolution times out to a conservative selected model", async () => {
  const fake = makeDynamicPi();
  createChatGptWebExtension({
    statusChecker: async () => HEALTH,
    budgetResolver: () => new Promise(() => {}),
  })(fake.api);
  fake.selectInitial();
  await fake.handlers.get("session_start")({}, fake.ctx);
  assert.equal(fake.currentModel().contextWindow, 90000);
  let message;
  fake.ctx.ui.notify = (text) => { message = text; };
  await fake.commands.get("chatgpt-web-status").handler("", fake.ctx);
  assert.match(message, /budget metadata timed out/);
  assert.match(message, /Provider\/runtime observations:/);
  assert.match(message, /Provider registration: REGISTERED/);
  assert.match(message, /Model\/effort eligibility: UNKNOWN/);
  assert.match(message, /Authentication: UNKNOWN/);
  assert.match(message, /Pi tools: registered=/);
});
