import { stat as fsStat, readFile as fsReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const BRIDGE_POLICY_VERSION = "6.1.4";
export const BRIDGE_CONFIG_VERSION = 3;
export const PI_DEFAULT_RESERVE_TOKENS = 16384;
export const BUDGET_REFRESH_TIMEOUT_MS = 750;
export const MAX_LOCAL_CONFIG_BYTES = 64 * 1024;

const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:17841/v1";
const DEFAULT_LOCAL_CONFIG_PATH = join(homedir(), ".codex-chatgpt-web", "config.json");

const FALLBACK_WINDOWS = Object.freeze({
  instant: 41000,
  solLow: 41000,
  solReasoning: 90000,
});

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_LOCAL_BASE_URL).replace(/\/+$/, "");
}

export function isDefaultLocalBridge(baseUrl) {
  return normalizeBaseUrl(baseUrl) === DEFAULT_LOCAL_BASE_URL;
}

export function normalizeBridgeEffort(value) {
  return ["low", "medium", "high", "xhigh", "max"].includes(value) ? value : null;
}

export function computePiBudget(
  bridgeContextWindow,
  bridgeAutoCompactTokenLimit,
  reserveTokens = PI_DEFAULT_RESERVE_TOKENS,
  automaticCompactionEnabled = true,
) {
  for (const [name, value] of Object.entries({
    bridgeContextWindow,
    bridgeAutoCompactTokenLimit,
    reserveTokens,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
  if (typeof automaticCompactionEnabled !== "boolean") {
    throw new TypeError("automaticCompactionEnabled must be a boolean");
  }

  const reserveWindowContribution = Math.min(reserveTokens, PI_DEFAULT_RESERVE_TOKENS);
  const piContextWindow = Math.min(
    bridgeContextWindow,
    bridgeAutoCompactTokenLimit + reserveWindowContribution,
  );
  const configuredPiCompactionThreshold = Math.max(0, piContextWindow - reserveTokens);
  return {
    piContextWindow,
    defaultPiReserveTokens: reserveTokens,
    defaultPiCompactionThreshold: configuredPiCompactionThreshold,
    piReserveTokens: reserveTokens,
    piAutomaticCompactionEnabled: automaticCompactionEnabled,
    piCompactionThreshold: automaticCompactionEnabled
      ? configuredPiCompactionThreshold
      : null,
    effectiveCompactionThreshold: automaticCompactionEnabled
      ? Math.min(bridgeAutoCompactTokenLimit, configuredPiCompactionThreshold)
      : null,
  };
}

function verifiedBudget(modelId, effort, bridgeContextWindow, bridgeAutoCompactTokenLimit) {
  return {
    modelId,
    effort,
    availability: "available",
    verified: true,
    bridgeContextWindow,
    bridgeAutoCompactTokenLimit,
    ...computePiBudget(bridgeContextWindow, bridgeAutoCompactTokenLimit),
  };
}

export function resolveKnownBridgeBudget(modelId, requestedEffort, capabilities) {
  if (!capabilities?.solAvailable) {
    return { supported: false, reason: "Sol is not available for this bridge account" };
  }

  const effort = modelId === "gpt-5.6-sol-instant"
    ? "low"
    : normalizeBridgeEffort(requestedEffort);
  if (!effort) {
    return { supported: false, reason: `unsupported or unknown effort: ${String(requestedEffort)}` };
  }

  let contextWindow;
  let autoCompactTokenLimit;

  if (capabilities.proAvailable) {
    contextWindow = effort === "max" ? 112193 : 111193;
    autoCompactTokenLimit = 95000;
  } else if (effort === "low") {
    contextWindow = 41000;
    autoCompactTokenLimit = 32000;
  } else if (
    effort === "medium"
    || effort === "high"
    || (effort === "xhigh" && capabilities.extraHighAvailable)
  ) {
    contextWindow = 90000;
    autoCompactTokenLimit = 80000;
  } else {
    return {
      supported: false,
      reason: effort === "xhigh"
        ? "Extra High is not available for this bridge account"
        : `effort ${effort} is not available for a non-Pro bridge account`,
    };
  }

  if (capabilities.experimentalBiggerContext) {
    contextWindow *= 3;
    autoCompactTokenLimit *= 3;
  }

  return {
    supported: true,
    budget: verifiedBudget(modelId, effort, contextWindow, autoCompactTokenLimit),
  };
}

function fallbackWindowFor(modelId, effort) {
  if (modelId === "gpt-5.6-sol-instant") return FALLBACK_WINDOWS.instant;
  return effort === "low" ? FALLBACK_WINDOWS.solLow : FALLBACK_WINDOWS.solReasoning;
}

export function createFallbackModelBudget(
  modelId,
  requestedEffort,
  reason,
  availability = "unknown",
) {
  const effort = modelId === "gpt-5.6-sol-instant"
    ? "low"
    : normalizeBridgeEffort(requestedEffort);
  const piContextWindow = fallbackWindowFor(modelId, effort);

  const legacySafeCompactionThreshold = Math.max(
    0,
    piContextWindow - PI_DEFAULT_RESERVE_TOKENS,
  );
  return {
    modelId,
    effort,
    availability,
    verified: false,
    bridgeContextWindow: null,
    bridgeAutoCompactTokenLimit: null,
    piContextWindow,
    defaultPiReserveTokens: PI_DEFAULT_RESERVE_TOKENS,
    defaultPiCompactionThreshold: legacySafeCompactionThreshold,
    piReserveTokens: PI_DEFAULT_RESERVE_TOKENS,
    piAutomaticCompactionEnabled: true,
    piCompactionThreshold: legacySafeCompactionThreshold,
    effectiveCompactionThreshold: legacySafeCompactionThreshold,
    legacySafeCompactionThreshold,
    piCompactionPolicyKnown: false,
    piCompactionPolicyReason: "effective Pi settings have not been read yet",
    reason,
  };
}

export function createFallbackBudgetState({
  baseUrl = DEFAULT_LOCAL_BASE_URL,
  effort = "medium",
  reason = "bridge budget metadata has not been verified",
  healthStatus = null,
  availability = "unknown",
} = {}) {
  return {
    verified: false,
    source: "conservative-fallback",
    reason,
    baseUrl: normalizeBaseUrl(baseUrl),
    healthStatus,
    effort: normalizeBridgeEffort(effort),
    capabilities: null,
    models: {
      "gpt-5.6-sol-instant": createFallbackModelBudget(
        "gpt-5.6-sol-instant",
        "low",
        reason,
        availability,
      ),
      "gpt-5.6-sol": createFallbackModelBudget(
        "gpt-5.6-sol",
        effort,
        reason,
        availability,
      ),
    },
  };
}

function validBoolean(value) {
  return typeof value === "boolean";
}

function validateLocalConfigSnapshot(config, healthStatus) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, reason: "local bridge config is not an object" };
  }
  if (config.version !== BRIDGE_CONFIG_VERSION) {
    return {
      ok: false,
      reason: `local bridge config schema ${String(config.version)} is unsupported`,
    };
  }
  if (
    config.releaseVersion !== BRIDGE_POLICY_VERSION
    || healthStatus.version !== BRIDGE_POLICY_VERSION
  ) {
    return {
      ok: false,
      reason: "bridge runtime/config version is not the supported 6.1.4 policy version",
    };
  }
  if (config.releaseVersion !== healthStatus.version) {
    return { ok: false, reason: "bridge runtime and local config versions do not match" };
  }
  if (config.host !== "127.0.0.1" || config.port !== 17841) {
    return {
      ok: false,
      reason: "local bridge config does not describe the default loopback endpoint",
    };
  }
  if (
    typeof config.mode !== "string"
    || (healthStatus.mode && config.mode !== healthStatus.mode)
  ) {
    return { ok: false, reason: "bridge runtime and local config modes do not match" };
  }

  for (const key of [
    "solAvailable",
    "proAvailable",
    "extraHighAvailable",
    "experimentalBiggerContext",
  ]) {
    if (!validBoolean(config[key])) {
      return {
        ok: false,
        reason: `local bridge config field ${key} is missing or malformed`,
      };
    }
  }

  return {
    ok: true,
    capabilities: Object.freeze({
      solAvailable: config.solAvailable,
      proAvailable: config.proAvailable,
      extraHighAvailable: config.extraHighAvailable,
      experimentalBiggerContext: config.experimentalBiggerContext,
    }),
  };
}

export async function readDefaultLocalBridgeCapabilities({
  healthStatus,
  configPath = DEFAULT_LOCAL_CONFIG_PATH,
  statImpl = fsStat,
  readFileImpl = fsReadFile,
} = {}) {
  if (!healthStatus?.reachable || !healthStatus?.healthy) {
    return {
      ok: false,
      reason: "bridge health metadata is unavailable or not trusted",
    };
  }
  if (healthStatus.version !== BRIDGE_POLICY_VERSION) {
    return {
      ok: false,
      reason: `bridge version ${String(healthStatus.version)} is unsupported for local budget derivation`,
    };
  }

  try {
    const info = await statImpl(configPath);
    if (!info?.isFile?.()) {
      return { ok: false, reason: "local bridge config is not a regular file" };
    }
    if (
      !Number.isFinite(info.size)
      || info.size <= 0
      || info.size > MAX_LOCAL_CONFIG_BYTES
    ) {
      return {
        ok: false,
        reason: "local bridge config size is outside the bounded read policy",
      };
    }

    const raw = await readFileImpl(configPath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_LOCAL_CONFIG_BYTES) {
      return {
        ok: false,
        reason: "local bridge config exceeded the bounded read policy",
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "local bridge config is malformed JSON" };
    }
    return validateLocalConfigSnapshot(parsed, healthStatus);
  } catch (error) {
    return {
      ok: false,
      reason: `local bridge config could not be read: ${error?.code || error?.message || String(error)}`,
    };
  }
}

export async function resolveBridgeContextBudgets({
  baseUrl = DEFAULT_LOCAL_BASE_URL,
  healthStatus,
  effort = "medium",
  configPath,
  statImpl,
  readFileImpl,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedEffort = normalizeBridgeEffort(effort);

  if (!isDefaultLocalBridge(normalizedBaseUrl)) {
    return createFallbackBudgetState({
      baseUrl: normalizedBaseUrl,
      effort: normalizedEffort,
      reason: "custom/remote bridge URL: default local bridge config was not consulted",
      healthStatus,
    });
  }

  if (
    !healthStatus?.reachable
    || !healthStatus?.healthy
    || !healthStatus?.acceptingTurns
  ) {
    return createFallbackBudgetState({
      baseUrl: normalizedBaseUrl,
      effort: normalizedEffort,
      reason: "bridge health metadata is unavailable, untrusted, or not accepting turns",
      healthStatus,
    });
  }

  const snapshot = await readDefaultLocalBridgeCapabilities({
    healthStatus,
    configPath,
    statImpl,
    readFileImpl,
  });
  if (!snapshot.ok) {
    return createFallbackBudgetState({
      baseUrl: normalizedBaseUrl,
      effort: normalizedEffort,
      reason: snapshot.reason,
      healthStatus,
    });
  }

  const capabilities = snapshot.capabilities;
  if (!capabilities.solAvailable) {
    return createFallbackBudgetState({
      baseUrl: normalizedBaseUrl,
      effort: normalizedEffort,
      reason: "bridge account capability reports Sol unavailable",
      healthStatus,
      availability: "unsupported",
    });
  }

  const instant = resolveKnownBridgeBudget(
    "gpt-5.6-sol-instant",
    "low",
    capabilities,
  );
  const sol = resolveKnownBridgeBudget(
    "gpt-5.6-sol",
    normalizedEffort,
    capabilities,
  );
  if (!instant.supported || !sol.supported) {
    const reason = !sol.supported ? sol.reason : instant.reason;
    return createFallbackBudgetState({
      baseUrl: normalizedBaseUrl,
      effort: normalizedEffort,
      reason,
      healthStatus,
      availability: "unsupported",
    });
  }

  return {
    verified: true,
    source: `bridge-health+local-config-policy-${BRIDGE_POLICY_VERSION}`,
    reason: null,
    baseUrl: normalizedBaseUrl,
    healthStatus,
    effort: normalizedEffort,
    capabilities,
    models: {
      "gpt-5.6-sol-instant": instant.budget,
      "gpt-5.6-sol": sol.budget,
    },
  };
}

export function applyPiCompactionSettings(state, settings, unavailableReason = null) {
  const models = {};
  for (const [modelId, budget] of Object.entries(state.models)) {
    let policy;
    let policyReason = unavailableReason;
    if (!policyReason) {
      try {
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("effective Pi settings unavailable");
        const compaction = settings.compaction ?? {};
        if (typeof compaction !== "object" || Array.isArray(compaction)) throw new Error("invalid Pi compaction settings");
        const enabled = compaction.enabled ?? true;
        if (typeof enabled !== "boolean") throw new Error("invalid Pi compaction enabled setting");
        const ordinary = compaction.reserveTokens;
        if (ordinary !== undefined && (!Number.isSafeInteger(ordinary) || ordinary < 0)) throw new Error("invalid Pi compaction reserveTokens");
        const override = compaction.modelOverrides?.["chatgpt-web/" + modelId];
        if (override !== undefined && (!override || typeof override !== "object" || Array.isArray(override))) throw new Error("invalid Pi model compaction override");
        const reserve = override?.reserveTokens;
        if (reserve !== undefined && (!Number.isSafeInteger(reserve) || reserve < 0)) throw new Error("invalid Pi model compaction reserveTokens");
        policy = { reserve: reserve ?? ordinary ?? PI_DEFAULT_RESERVE_TOKENS, enabled };
      } catch (error) {
        policyReason = error.message;
      }
    }
    const contextWindow = budget.bridgeContextWindow ?? budget.piContextWindow;
    const limit = budget.bridgeAutoCompactTokenLimit
      ?? budget.legacySafeCompactionThreshold
      ?? Math.max(0, contextWindow - PI_DEFAULT_RESERVE_TOKENS);
    const mapped = computePiBudget(contextWindow, limit, policy?.reserve ?? 0, policy?.enabled ?? true);
    models[modelId] = {
      ...budget,
      ...mapped,
      piCompactionPolicyKnown: Boolean(policy),
      piCompactionPolicyReason: policyReason,
      ...(!policy ? {
        piReserveTokens: null, piAutomaticCompactionEnabled: null,
        piCompactionThreshold: null, effectiveCompactionThreshold: null,
      } : {}),
    };
  }
  return { ...state, models };
}

export async function withBudgetTimeout(operation, timeoutMs = BUDGET_REFRESH_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("bridge budget metadata timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function numberOrUnknown(value) {
  return Number.isSafeInteger(value) ? value.toLocaleString("en-US") : "unknown";
}

export function formatContextBudgetStatus(state, options = {}) {
  const modelId = options.modelId || "gpt-5.6-sol";
  const budget = state?.models?.[modelId] || state?.models?.["gpt-5.6-sol"];
  if (!budget) return "Context budget: unavailable";
  const policyKnown = budget.piCompactionPolicyKnown === true;
  const automatic = policyKnown ? (budget.piAutomaticCompactionEnabled ? "enabled" : "disabled") : "unknown";
  const lines = [
    "Context budget: " + (state.verified ? "verified" : "conservative fallback (unverified)"),
    "Budget source: " + state.source,
    "Model/effort: " + modelId + " / " + (budget.effort || "unknown"),
    "Bridge raw context: " + numberOrUnknown(budget.bridgeContextWindow),
    "Bridge auto-compact limit: " + numberOrUnknown(budget.bridgeAutoCompactTokenLimit),
    "Pi advertised context: " + numberOrUnknown(budget.piContextWindow),
    "Pi automatic compaction: " + automatic,
    "Pi effective reserve: " + numberOrUnknown(budget.piReserveTokens),
    "Effective safe compaction threshold: " + (automatic === "disabled" ? "disabled" : numberOrUnknown(budget.effectiveCompactionThreshold)),
  ];
  if (state.reason) lines.push("Budget fallback reason: " + state.reason);
  if (!policyKnown) lines.push("Pi policy fallback reason: " + (budget.piCompactionPolicyReason || "effective settings unavailable"));
  return lines.join("\n");
}
