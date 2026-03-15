import {
  emptyPluginConfigSchema,
  onDiagnosticEvent,
} from "openclaw/plugin-sdk/diagnostics-otel";
import {
  appendTelemetryFooterToAssistantMessage,
  appendTelemetryFooterToAssistantTexts,
  buildNormalizedTelemetryFromDiagnosticEvent,
  buildNormalizedTelemetryFromLlmOutput,
  formatDiagnosticsLogEvent,
  formatTelemetryFooter,
  primeInternalContextResolver,
} from "./lib/telemetry.js";

function createPluginState() {
  return {
    diagnosticListenerStop: null,
    agentDurationMsBySessionId: new Map(),
    diagnosticsLoggedBySessionId: new Set(),
    runStartMsByRunId: new Map(),
    runStartMsBySessionId: new Map(),
    runIdBySessionId: new Map(),
  };
}

function emitDiagnosticsRecord(state, logger, params) {
  if (typeof params?.sessionId === "string" && state.diagnosticsLoggedBySessionId.has(params.sessionId)) {
    return;
  }

  const record = formatDiagnosticsLogEvent({
    sessionId: params?.sessionId,
    sessionKey: params?.sessionKey,
    telemetry: params?.telemetry,
  });

  if (typeof params?.sessionId === "string") {
    state.diagnosticsLoggedBySessionId.add(params.sessionId);
  }

  if (typeof process?.stderr?.write === "function") {
    process.stderr.write(`${record}\n`);
    return;
  }

  logger.info(record);
}

function ensureDiagnosticsListener(state, logger, config) {
  if (state.diagnosticListenerStop) {
    return;
  }

  if (config?.diagnostics?.enabled !== true) {
    logger.warn(
      "moltbox-telemetry: diagnostics.enabled is false; diagnostics-side telemetry normalization is inactive",
    );
  }

  primeInternalContextResolver(logger);
  state.diagnosticListenerStop = onDiagnosticEvent((event) => {
    const telemetry = buildNormalizedTelemetryFromDiagnosticEvent(event);
    if (!telemetry) {
      return;
    }

    emitDiagnosticsRecord(state, logger, {
      sessionId: event.sessionId,
      sessionKey: event.sessionKey,
      telemetry,
    });
  });
}

const plugin = {
  id: "moltbox-telemetry",
  name: "Moltbox Telemetry",
  description: "Normalize OpenClaw model usage into the Moltbox telemetry contract",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    const state = createPluginState();

    primeInternalContextResolver(api.logger);
    ensureDiagnosticsListener(state, api.logger, api.config);

    api.on("llm_input", (event, ctx) => {
      if (!event?.runId) {
        return;
      }

      const startedAt = Date.now();
      state.runStartMsByRunId.set(event.runId, startedAt);
      if (ctx?.sessionId) {
        state.diagnosticsLoggedBySessionId.delete(ctx.sessionId);
        state.runStartMsBySessionId.set(ctx.sessionId, startedAt);
        state.runIdBySessionId.set(ctx.sessionId, event.runId);
      }
    });

    api.on("llm_output", (event, ctx) => {
      const runStartedAt =
        typeof event?.runId === "string" ? state.runStartMsByRunId.get(event.runId) : undefined;
      const sessionStartedAt =
        ctx?.sessionId ? state.runStartMsBySessionId.get(ctx.sessionId) : undefined;
      const agentDurationMs =
        ctx?.sessionId ? state.agentDurationMsBySessionId.get(ctx.sessionId) : undefined;
      const startedAt =
        typeof runStartedAt === "number" ? runStartedAt : sessionStartedAt;
      const latencyMs =
        typeof startedAt === "number"
          ? Math.max(1, Date.now() - startedAt)
          : typeof agentDurationMs === "number"
            ? Math.max(1, agentDurationMs)
            : undefined;
      const telemetry = buildNormalizedTelemetryFromLlmOutput({
        event,
        config: api.config,
        latencyMs,
      });

      if (!telemetry || Object.keys(telemetry).length === 0) {
        return;
      }

      const footer = formatTelemetryFooter(telemetry);
      appendTelemetryFooterToAssistantTexts(event.assistantTexts, footer) ||
        appendTelemetryFooterToAssistantMessage(event.lastAssistant, footer);

      if (api.config?.diagnostics?.enabled === true) {
        emitDiagnosticsRecord(state, api.logger, {
          sessionId: ctx?.sessionId,
          sessionKey: ctx?.sessionKey,
          telemetry,
        });
      }

      if (typeof event?.runId === "string") {
        state.runStartMsByRunId.delete(event.runId);
      }
      if (ctx?.sessionId) {
        const previousRunId = state.runIdBySessionId.get(ctx.sessionId);
        if (previousRunId) {
          state.runStartMsByRunId.delete(previousRunId);
        }
        state.agentDurationMsBySessionId.delete(ctx.sessionId);
        state.runStartMsBySessionId.delete(ctx.sessionId);
        state.runIdBySessionId.delete(ctx.sessionId);
      }
    });

    api.on("agent_end", (event, ctx) => {
      if (!ctx?.sessionId) {
        return;
      }

      if (typeof event?.durationMs === "number" && Number.isFinite(event.durationMs)) {
        state.agentDurationMsBySessionId.set(ctx.sessionId, Math.max(1, event.durationMs));
      }

      const runId = state.runIdBySessionId.get(ctx.sessionId);
      if (runId) {
        state.runStartMsByRunId.delete(runId);
      }
    });

    api.on("gateway_stop", () => {
      state.diagnosticListenerStop?.();
      state.diagnosticListenerStop = null;
      state.agentDurationMsBySessionId.clear();
      state.diagnosticsLoggedBySessionId.clear();
      state.runStartMsByRunId.clear();
      state.runStartMsBySessionId.clear();
      state.runIdBySessionId.clear();
    });
  },
};

export default plugin;
