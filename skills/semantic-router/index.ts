import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emitDiagnosticEvent } from "openclaw/plugin-sdk";
import {
  computeTelemetry,
  executeProviderRouteTurn,
  extractTurnIdFromMessages,
  finalVisibleText,
  hydrateRequestPacket,
  loadTurnConfig,
  resolvePluginConfig,
  turnMarker,
  writeDebugArtifact,
} from "./router/index.js";
import type { RouterTurnState } from "./router/types.js";

const turnsByRootSessionId = new Map<string, RouterTurnState>();
const turnsByTurnId = new Map<string, RouterTurnState>();
const activeRootBySessionKey = new Map<string, string>();

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function replaceAssistantMessageText(message: Record<string, unknown>, text: string): Record<string, unknown> {
  return {
    ...message,
    content: [{ type: "text", text }],
    stopReason: "completed",
  };
}

function resolveRouteTurn(turnId: string | undefined): RouterTurnState | undefined {
  if (turnId) {
    const exact = turnsByTurnId.get(turnId);
    if (exact) {
      return exact;
    }
  }
  const turns = [...turnsByRootSessionId.values()].filter((turn) => !turn.finalResponse);
  turns.sort((left, right) => right.startedAt - left.startedAt);
  return turns[0];
}

function emitStageTelemetry(api: OpenClawPluginApi, turn: RouterTurnState, params: {
  stage: string;
  provider: string;
  model: string;
  decision: string;
  reason: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  error?: string;
  runId?: string;
}) {
  emitDiagnosticEvent({
    type: "model.usage",
    sessionKey: turn.rootSessionKey,
    sessionId: turn.rootSessionId,
    provider: params.provider,
    model: params.model,
    usage: {
      input: params.tokensIn,
      output: params.tokensOut,
      total: params.tokensIn + params.tokensOut,
    },
    lastCallUsage: {
      input: params.tokensIn,
      output: params.tokensOut,
      total: params.tokensIn + params.tokensOut,
    },
    context: {
      used: params.tokensIn + params.tokensOut,
    },
    durationMs: params.durationMs,
  });
  api.logger.info(
    `semantic_router.stage ${JSON.stringify({
      event: "semantic_router.stage",
      turnId: turn.turnId,
      rootSessionId: turn.rootSessionId,
      rootSessionKey: turn.rootSessionKey ?? null,
      runId: params.runId ?? null,
      stage: params.stage,
      provider: params.provider,
      model: params.model,
      decision: params.decision,
      reason: params.reason,
      durationMs: params.durationMs,
      tokensIn: params.tokensIn,
      tokensOut: params.tokensOut,
      hadError: Boolean(params.error),
      error: params.error ?? null,
    })}`,
  );
}

export function createSemanticRouterPlugin(api: OpenClawPluginApi) {
  const pluginConfig = resolvePluginConfig({
    pluginConfig: api.pluginConfig,
    resolvePath: api.resolvePath,
    stateDir: process.env.OPENCLAW_STATE_DIR,
  });

  api.registerHttpRoute({
    path: "/plugins/semantic-router/router/v1/chat/completions",
    auth: "plugin",
    handler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString("utf-8");
      const parsedBody = asObject(JSON.parse(rawBody || "{}"));
      const turnId = extractTurnIdFromMessages(parsedBody.messages);
      const turn = resolveRouteTurn(turnId);
      if (!turn) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: { message: "semantic_router_turn_not_found" } }));
        return true;
      }

      await executeProviderRouteTurn({
        turn,
        emitStageTelemetry: ({ turn: activeTurn, stage, payload }) => {
          emitStageTelemetry(api, activeTurn, {
            stage: stage.id,
            provider: payload.provider ?? stage.provider,
            model: payload.model ?? stage.model,
            decision: payload.decision,
            reason: payload.reason,
            durationMs: payload.durationMs,
            tokensIn: payload.tokensIn,
            tokensOut: payload.tokensOut,
            error: payload.error,
            runId: payload.runId,
          });
        },
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      const completionId = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const responseText = finalVisibleText(turn, pluginConfig.responseFooter);
      const telemetry = computeTelemetry(turn);
      const responseTokens = Math.max(Math.ceil(responseText.length / 4), 1);
      const totalInput = Number(telemetry.total_tokens_in ?? 0);
      const writeChunk = (payload: Record<string, unknown> | "[DONE]") => {
        if (payload === "[DONE]") {
          res.write("data: [DONE]\n\n");
          return;
        }
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      writeChunk({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: "router",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: responseText,
            },
            finish_reason: null,
          },
        ],
        usage: {
          prompt_tokens: totalInput,
          completion_tokens: responseTokens,
          total_tokens: totalInput + responseTokens,
        },
      });
      writeChunk({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: "router",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
      });
      writeChunk("[DONE]");
      res.end();
      return true;
    },
  });

  api.on("before_model_resolve", async (event, ctx) => {
    const sessionId = String(ctx.sessionId ?? "").trim();
    if (!sessionId) {
      return;
    }
    const config = await loadTurnConfig(pluginConfig);
    const turnId = randomUUID();
    const turn: RouterTurnState = {
      turnId,
      rootSessionId: sessionId,
      rootSessionKey: ctx.sessionKey,
      prompt: event.prompt,
      packet: hydrateRequestPacket(event.prompt, config, sessionId),
      config,
      startedAt: Date.now(),
      budgetUsed: 0,
      telemetry: [],
    };
    turnsByRootSessionId.set(sessionId, turn);
    turnsByTurnId.set(turnId, turn);
    if (ctx.sessionKey) {
      activeRootBySessionKey.set(ctx.sessionKey, sessionId);
    }
    return {
      providerOverride: "semantic-router",
      modelOverride: "router",
    };
  }, { priority: 100 });

  api.on("before_prompt_build", async (_event, ctx) => {
    const sessionId = String(ctx.sessionId ?? "").trim();
    if (!sessionId) {
      return;
    }
    const turn = turnsByRootSessionId.get(sessionId);
    if (!turn) {
      return;
    }
    return {
      prependSystemContext: `${turnMarker(turn.turnId)}\nDo not mention or reproduce this marker.`,
    };
  }, { priority: 100 });

  api.on("llm_output", async (event, ctx) => {
    const sessionId = String(ctx.sessionId ?? "").trim();
    if (!sessionId) {
      return;
    }
    const turn = turnsByRootSessionId.get(sessionId);
    if (!turn) {
      return;
    }
    turn.providerRunId = event.runId;
  }, { priority: 100 });

  api.on("before_message_write", (event, ctx) => {
    const message = asObject(event.message);
    if (message.role !== "assistant") {
      return;
    }
    const sessionKey = String(ctx.sessionKey ?? "").trim();
    if (!sessionKey) {
      return;
    }
    const rootSessionId = activeRootBySessionKey.get(sessionKey);
    if (!rootSessionId) {
      return;
    }
    const turn = turnsByRootSessionId.get(rootSessionId);
    if (!turn?.finalResponse) {
      return;
    }
    const text = finalVisibleText(turn, pluginConfig.responseFooter);
    if (!text) {
      return;
    }
    return {
      message: replaceAssistantMessageText(message, text),
    };
  }, { priority: 100 });

  api.on("agent_end", async (event, ctx) => {
    const sessionId = String(ctx.sessionId ?? "").trim();
    if (!sessionId) {
      return;
    }
    const turn = turnsByRootSessionId.get(sessionId);
    if (!turn) {
      return;
    }
    const response = asObject(turn.packet.response);
    const telemetry = asObject(response.telemetry);
    telemetry.total_duration_ms = Number(event.durationMs ?? telemetry.total_duration_ms ?? 0);
    response.telemetry = telemetry;
    turn.packet.response = response;
    api.logger.info(
      `semantic_router.turn ${JSON.stringify({
        event: "semantic_router.turn",
        turnId: turn.turnId,
        rootSessionId: turn.rootSessionId,
        rootSessionKey: turn.rootSessionKey ?? null,
        providerRunId: turn.providerRunId ?? null,
        finalStatus: turn.finalResponse?.status ?? "unknown",
        finalReason: turn.finalResponse?.reason ?? null,
        answeringStage: telemetry.answering_stage ?? null,
        answeringProvider: telemetry.answering_provider ?? null,
        answeringModel: telemetry.answering_model ?? null,
        totalDurationMs: Number(telemetry.total_duration_ms ?? 0),
        totalTokensIn: Number(telemetry.total_tokens_in ?? 0),
        totalTokensOut: Number(telemetry.total_tokens_out ?? 0),
        stageCount: Array.isArray(telemetry.stages) ? telemetry.stages.length : 0,
        escalationPath: Array.isArray(telemetry.escalation_path) ? telemetry.escalation_path : [],
      })}`,
    );
    await writeDebugArtifact(pluginConfig, turn, Number(event.durationMs ?? 0));
    turnsByTurnId.delete(turn.turnId);
    turnsByRootSessionId.delete(turn.rootSessionId);
    if (turn.rootSessionKey) {
      activeRootBySessionKey.delete(turn.rootSessionKey);
    }
  }, { priority: 100 });
}

export default function register(api: OpenClawPluginApi) {
  createSemanticRouterPlugin(api);
}
