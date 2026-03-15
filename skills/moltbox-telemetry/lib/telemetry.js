import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const ANTHROPIC_1M_MODEL_PREFIXES = ["claude-opus-4", "claude-sonnet-4"];
const ANTHROPIC_CONTEXT_1M_TOKENS = 1_048_576;
const TELEMETRY_PREFIX = "Telemetry: ";

let internalContextResolver = null;
let contextResolverLoadStarted = false;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function toNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function roundContextPct(value) {
  return Math.round(value * 10) / 10;
}

function normalizeProviderId(provider) {
  return typeof provider === "string" ? provider.trim().toLowerCase() : "";
}

function hasNumericUsageFields(value) {
  if (!isRecord(value)) {
    return false;
  }
  return (
    toNonNegativeNumber(value.input) !== undefined ||
    toNonNegativeNumber(value.output) !== undefined ||
    toNonNegativeNumber(value.total) !== undefined ||
    toNonNegativeNumber(value.cacheRead) !== undefined ||
    toNonNegativeNumber(value.cacheWrite) !== undefined
  );
}

function selectUsageSource(...sources) {
  for (const source of sources) {
    if (hasNumericUsageFields(source)) {
      return source;
    }
  }
  return null;
}

function resolveTokenCounts(source) {
  if (!isRecord(source)) {
    return {};
  }

  const inputTokens = toNonNegativeNumber(source.input);
  const outputTokens = toNonNegativeNumber(source.output);
  const cacheRead = toNonNegativeNumber(source.cacheRead) ?? 0;
  const cacheWrite = toNonNegativeNumber(source.cacheWrite) ?? 0;
  const explicitTotal = toNonNegativeNumber(source.total);

  let totalTokens = explicitTotal;
  if (totalTokens === undefined) {
    const derivedParts = [inputTokens, outputTokens];
    const hasBaseCounts = derivedParts.some((value) => value !== undefined);
    if (hasBaseCounts) {
      totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0) + cacheRead + cacheWrite;
    }
  }

  return compactTelemetry({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  });
}

function resolveConfiguredProviderContextWindow(config, provider, model) {
  const providers = isRecord(config?.models?.providers) ? config.models.providers : null;
  if (!providers) {
    return undefined;
  }

  const normalizedProvider = normalizeProviderId(provider);
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (normalizeProviderId(providerId) !== normalizedProvider) {
      continue;
    }
    const models = Array.isArray(providerConfig?.models) ? providerConfig.models : [];
    for (const entry of models) {
      if (!isRecord(entry) || entry.id !== model) {
        continue;
      }
      const contextWindow = toPositiveNumber(entry.contextWindow);
      if (contextWindow !== undefined) {
        return contextWindow;
      }
    }
  }

  return undefined;
}

function resolveConfiguredModelParams(config, provider, model) {
  const models = isRecord(config?.agents?.defaults?.models) ? config.agents.defaults.models : null;
  if (!models) {
    return undefined;
  }

  const expectedKey = `${normalizeProviderId(provider)}/${String(model).trim().toLowerCase()}`;
  for (const [rawKey, entry] of Object.entries(models)) {
    if (String(rawKey).trim().toLowerCase() !== expectedKey) {
      continue;
    }
    const params = entry?.params;
    return isRecord(params) ? params : undefined;
  }

  return undefined;
}

function isAnthropic1MModel(provider, model) {
  if (normalizeProviderId(provider) !== "anthropic") {
    return false;
  }

  const normalizedModel = typeof model === "string" ? model.trim().toLowerCase() : "";
  const candidate = normalizedModel.includes("/")
    ? (normalizedModel.split("/").at(-1) ?? normalizedModel)
    : normalizedModel;
  return ANTHROPIC_1M_MODEL_PREFIXES.some((prefix) => candidate.startsWith(prefix));
}

function resolveFallbackContextWindow(config) {
  return toPositiveNumber(config?.agents?.defaults?.contextTokens);
}

export function compactTelemetry(telemetry) {
  return Object.fromEntries(
    Object.entries(telemetry).filter(([, value]) => value !== undefined && value !== null),
  );
}

export function formatTelemetryFooter(telemetry) {
  return `${TELEMETRY_PREFIX}${JSON.stringify(telemetry)}`;
}

export function appendFooterToText(text, footer) {
  const base = typeof text === "string" ? text : "";
  if (base.includes(footer)) {
    return base;
  }
  if (!base.trim()) {
    return footer;
  }
  const separator = base.endsWith("\n") ? "" : "\n";
  return `${base}${separator}${footer}`;
}

export function appendTelemetryFooterToAssistantTexts(assistantTexts, footer) {
  if (!Array.isArray(assistantTexts) || assistantTexts.length === 0) {
    return false;
  }

  for (let index = assistantTexts.length - 1; index >= 0; index -= 1) {
    if (typeof assistantTexts[index] !== "string") {
      continue;
    }
    assistantTexts[index] = appendFooterToText(assistantTexts[index], footer);
    return true;
  }

  assistantTexts.push(footer);
  return true;
}

export function appendTelemetryFooterToAssistantMessage(message, footer) {
  if (!isRecord(message) || message.role !== "assistant") {
    return false;
  }

  if (typeof message.content === "string") {
    message.content = appendFooterToText(message.content, footer);
    return true;
  }

  if (!Array.isArray(message.content)) {
    message.content = [{ type: "text", text: footer }];
    return true;
  }

  for (let index = message.content.length - 1; index >= 0; index -= 1) {
    const block = message.content[index];
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      continue;
    }
    block.text = appendFooterToText(block.text, footer);
    return true;
  }

  message.content.push({ type: "text", text: footer });
  return true;
}

export function buildNormalizedTelemetryFromDiagnosticEvent(event) {
  if (!isRecord(event) || event.type !== "model.usage") {
    return null;
  }

  const tokenCounts = resolveTokenCounts(selectUsageSource(event.lastCallUsage, event.usage));
  const contextUsed = toPositiveNumber(event.context?.used) ?? tokenCounts.total_tokens;
  const contextWindow = toPositiveNumber(event.context?.limit);

  return compactTelemetry({
    model: typeof event.model === "string" && event.model.trim() ? event.model : undefined,
    provider:
      typeof event.provider === "string" && event.provider.trim() ? event.provider : undefined,
    ...tokenCounts,
    context_pct:
      contextUsed !== undefined && contextWindow !== undefined
        ? roundContextPct((contextUsed / contextWindow) * 100)
        : undefined,
    provider_latency_ms: toPositiveNumber(event.durationMs),
  });
}

export function buildNormalizedTelemetryFromLlmOutput(params) {
  const event = params?.event;
  if (!isRecord(event)) {
    return null;
  }

  const provider =
    (typeof event.lastAssistant?.provider === "string" && event.lastAssistant.provider.trim()
      ? event.lastAssistant.provider
      : undefined) ??
    (typeof event.provider === "string" && event.provider.trim() ? event.provider : undefined);

  const model =
    (typeof event.lastAssistant?.model === "string" && event.lastAssistant.model.trim()
      ? event.lastAssistant.model
      : undefined) ??
    (typeof event.model === "string" && event.model.trim() ? event.model : undefined);

  const tokenCounts = resolveTokenCounts(selectUsageSource(event.lastAssistant?.usage, event.usage));
  const contextWindow = resolveContextWindow({
    config: params?.config,
    provider,
    model,
  });
  const contextUsed = tokenCounts.total_tokens;

  return compactTelemetry({
    model,
    provider,
    ...tokenCounts,
    context_pct:
      contextUsed !== undefined && contextWindow !== undefined
        ? roundContextPct((contextUsed / contextWindow) * 100)
        : undefined,
    provider_latency_ms: toPositiveNumber(params?.latencyMs),
  });
}

export function formatDiagnosticsLogEvent(params) {
  return JSON.stringify(
    compactTelemetry({
      type: "moltbox.telemetry",
      session_id: params?.sessionId,
      session_key: params?.sessionKey,
      telemetry: params?.telemetry,
    }),
  );
}

export function resolveContextWindow(params) {
  const provider = typeof params?.provider === "string" ? params.provider : undefined;
  const model = typeof params?.model === "string" ? params.model : undefined;
  const config = params?.config;

  if (internalContextResolver && provider && model) {
    try {
      const resolved = internalContextResolver({
        cfg: config,
        provider,
        model,
      });
      if (toPositiveNumber(resolved) !== undefined) {
        return resolved;
      }
    } catch {
      // Fall back to local best-effort resolution below.
    }
  }

  if (provider && model) {
    const configuredWindow = resolveConfiguredProviderContextWindow(config, provider, model);
    if (configuredWindow !== undefined) {
      return configuredWindow;
    }

    const modelParams = resolveConfiguredModelParams(config, provider, model);
    if (modelParams?.context1m === true && isAnthropic1MModel(provider, model)) {
      return ANTHROPIC_CONTEXT_1M_TOKENS;
    }
  }

  return resolveFallbackContextWindow(config);
}

export function primeInternalContextResolver(logger) {
  if (contextResolverLoadStarted) {
    return;
  }

  contextResolverLoadStarted = true;
  void (async () => {
    try {
      const openclawEntry = require.resolve("openclaw");
      const packageRoot = path.dirname(path.dirname(openclawEntry));
      const moduleUrl = pathToFileURL(path.join(packageRoot, "dist", "agents", "context.js")).href;
      const moduleNs = await import(moduleUrl);
      if (typeof moduleNs.resolveContextTokensForModel === "function") {
        internalContextResolver = moduleNs.resolveContextTokensForModel;
      }
    } catch (error) {
      logger?.debug?.(
        `moltbox-telemetry: unable to load OpenClaw context resolver (${String(error)})`,
      );
    }
  })();
}
