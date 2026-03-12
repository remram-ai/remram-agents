import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { approximateTokens, assessPromptComplexity, canAdvanceStage, shouldSkipForcedAnswerRetry } from "./guardrails.js";
import { callStageModel, loadSemanticRouterConfig, renderStructuredValue, resolveStageResult } from "./stages.js";
import type {
  FinalResponse,
  PluginConfig,
  ResolvedStageDefinition,
  RouterTurnState,
  SemanticRouterConfig,
  StageTelemetryEmitter,
  StageTelemetryPayload,
  StageResult,
} from "./types.js";

export const TURN_MARKER_PREFIX = "Remram Semantic Router Turn ID:";

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function nowIso(): string {
  return new Date().toISOString();
}

export function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function turnMarker(turnId: string): string {
  return `${TURN_MARKER_PREFIX} ${turnId}`;
}

function stripTurnMarker(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.includes(TURN_MARKER_PREFIX))
    .join("\n")
    .trim();
}

function flattenContent(value: unknown): string {
  if (typeof value === "string") {
    return stripTurnMarker(value);
  }
  if (!Array.isArray(value)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of value) {
    const obj = asObject(item);
    if (obj.type === "text" && typeof obj.text === "string") {
      parts.push(stripTurnMarker(obj.text));
    }
  }
  return parts.join("\n").trim();
}

export function extractTurnIdFromMessages(messages: unknown): string | undefined {
  for (const message of asArray<Record<string, unknown>>(messages)) {
    const content = flattenContent(message.content);
    if (!content) {
      continue;
    }
    const match = content.match(/Remram Semantic Router Turn ID:\s*([A-Za-z0-9_-]+)/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

export function resolvePluginConfig(params: {
  pluginConfig?: Record<string, unknown>;
  resolvePath: (value: string) => string;
  stateDir?: string;
}): PluginConfig {
  const config = asObject(params.pluginConfig);
  const defaultStateDir = params.stateDir
    ? path.resolve(params.stateDir)
    : path.resolve(
        process.env.OPENCLAW_STATE_DIR ??
          path.join(process.env.OPENCLAW_HOME ?? process.env.USERPROFILE ?? process.env.HOME ?? ".", ".openclaw"),
      );
  return {
    routerConfigPath:
      typeof config.routerConfigPath === "string" && config.routerConfigPath.trim()
        ? path.resolve(config.routerConfigPath)
        : params.resolvePath("./router/default-config.json"),
    debugDir:
      typeof config.debugDir === "string" && config.debugDir.trim()
        ? path.resolve(config.debugDir)
        : path.join(defaultStateDir, "semantic-router-debug"),
    responseFooter: config.responseFooter === "concise" ? "concise" : "off",
  };
}

export async function loadTurnConfig(pluginConfig: PluginConfig): Promise<SemanticRouterConfig> {
  return loadSemanticRouterConfig(pluginConfig.routerConfigPath);
}

export function hydrateRequestPacket(prompt: string, config: SemanticRouterConfig, rootSessionId: string): Record<string, unknown> {
  return {
    request: {
      id: `request_${randomUUID()}`,
      text: prompt,
      surface: "openclaw_chat",
      timestamp: nowIso(),
      attachments: [],
    },
    requester: {
      ...config.requesterDefaults,
      session_id: rootSessionId,
    },
    conversations: [],
    context: [],
    preferences: {},
    instructions: [],
    extended_context: [],
    routing: {
      current_stage: null,
      next_stage: config.stages[0]?.id ?? null,
      stage_index: 0,
      max_escalation_depth: config.guardrails.maxEscalationDepth,
      force_answer_at_max_depth: config.guardrails.forceAnswerAtMaxDepth,
      upstream_flags: [],
      estimated_request_tokens: approximateTokens(prompt),
    },
    ledger: [
      {
        stage: "preflight",
        kind: "preflight",
        decision: "ready",
        reason: "deterministic request conditioning complete",
        duration_ms: 0,
        tokens_in: approximateTokens(prompt),
        tokens_out: 0,
        timestamp: nowIso(),
        notes: "no preprocessing applied",
      },
    ],
    response: {
      status: "pending",
    },
  };
}

function appendLedgerEntry(packet: Record<string, unknown>, entry: Record<string, unknown>): void {
  const ledger = asArray<Record<string, unknown>>(packet.ledger);
  ledger.push(entry);
  packet.ledger = ledger;
}

function getStageByIndex(config: SemanticRouterConfig, stageIndex: number): ResolvedStageDefinition {
  const stage = config.stages[stageIndex];
  if (!stage) {
    throw new Error(`unknown semantic router stage index ${stageIndex}`);
  }
  return stage;
}

function setCurrentStage(packet: Record<string, unknown>, stageIndex: number, config: SemanticRouterConfig): ResolvedStageDefinition {
  const routing = asObject(packet.routing);
  const stage = getStageByIndex(config, stageIndex);
  routing.current_stage = stage.id;
  routing.stage_index = stageIndex;
  routing.next_stage = config.stages[stageIndex + 1]?.id ?? null;
  packet.routing = routing;
  return stage;
}

export function computeTelemetry(turn: RouterTurnState): Record<string, unknown> {
  const totalTokensIn = turn.telemetry.reduce((sum, item) => sum + item.tokensIn, 0);
  const totalTokensOut = turn.telemetry.reduce((sum, item) => sum + item.tokensOut, 0);
  const totalDurationMs = turn.telemetry.reduce((sum, item) => sum + item.durationMs, 0);
  const answeringStage = turn.telemetry.findLast((item) => item.decision === "answer");
  return {
    stages: turn.telemetry.map((item) => ({
      stage: item.stage,
      provider: item.provider,
      model: item.model,
      decision: item.decision,
      duration_ms: item.durationMs,
      tokens_in: item.tokensIn,
      tokens_out: item.tokensOut,
      timestamp: item.timestamp,
    })),
    escalation_path: turn.telemetry.map((item) => item.stage),
    answering_stage: answeringStage?.stage ?? null,
    answering_provider: answeringStage?.provider ?? null,
    answering_model: answeringStage?.model ?? null,
    total_tokens_in: totalTokensIn,
    total_tokens_out: totalTokensOut,
    total_duration_ms: totalDurationMs,
  };
}

function updatePacketTelemetry(turn: RouterTurnState): void {
  const response = asObject(turn.packet.response);
  response.telemetry = computeTelemetry(turn);
  turn.packet.response = response;
}

function finalizeTurn(turn: RouterTurnState, finalResponse: FinalResponse): void {
  turn.finalResponse = finalResponse;
  const response = asObject(turn.packet.response);
  response.status = finalResponse.status;
  response.status_message = finalResponse.statusMessage;
  if (finalResponse.answer) {
    response.answer = finalResponse.answer;
  }
  if (finalResponse.agentTarget) {
    response.agent_target = finalResponse.agentTarget;
  }
  if (finalResponse.error) {
    response.error = finalResponse.error;
  }
  turn.packet.response = response;
  const routing = asObject(turn.packet.routing);
  routing.terminal_reason = finalResponse.reason;
  if (finalResponse.agentTarget) {
    routing.agent_target = finalResponse.agentTarget;
    routing.dispatch_stub = {
      status: "pending",
      agent_target: finalResponse.agentTarget,
      reason: finalResponse.reason,
    };
  }
  turn.packet.routing = routing;
  updatePacketTelemetry(turn);
}

function footerText(turn: RouterTurnState, mode: "off" | "concise"): string {
  if (mode === "off") {
    return "";
  }
  const telemetry = computeTelemetry(turn);
  const stages = asArray<Record<string, unknown>>(telemetry.stages);
  const lines = ["[Semantic Router]"];
  for (const stage of stages) {
    lines.push(
      `${String(stage.stage)} | ${String(stage.provider)}/${String(stage.model)} | ${Number(stage.duration_ms)} ms | in ${Number(stage.tokens_in)} | out ${Number(stage.tokens_out)}`,
    );
  }
  lines.push(`total | ${Number(telemetry.total_duration_ms)} ms`);
  return lines.join("\n");
}

export function finalVisibleText(turn: RouterTurnState, mode: "off" | "concise"): string {
  const finalResponse = turn.finalResponse;
  if (!finalResponse) {
    return "";
  }
  const base =
    finalResponse.status === "answer"
      ? String(finalResponse.answer ?? "")
      : finalResponse.status === "spawn_agent"
        ? finalResponse.statusMessage || `Dispatching workflow for ${finalResponse.agentTarget ?? "agent_router_pending"}.`
        : finalResponse.statusMessage || finalResponse.error || "Semantic Router failed.";
  const footer = footerText(turn, mode);
  return footer ? `${base}\n\n${footer}` : base;
}

function recordStageTelemetry(
  turn: RouterTurnState,
  stage: ResolvedStageDefinition,
  payload: StageTelemetryPayload,
  emitStageTelemetry: StageTelemetryEmitter,
): void {
  const timestamp = nowIso();
  const provider = payload.provider ?? stage.provider;
  const model = payload.model ?? stage.model;
  turn.telemetry.push({
    runId: payload.runId,
    stage: stage.id,
    provider,
    model,
    decision: payload.decision,
    reason: payload.reason,
    durationMs: payload.durationMs,
    tokensIn: payload.tokensIn,
    tokensOut: payload.tokensOut,
    timestamp,
    rawContent: payload.rawContent,
  });
  appendLedgerEntry(turn.packet, {
    stage: stage.id,
    kind: "semantic_stage",
    provider,
    model,
    decision: payload.decision,
    reason: payload.reason,
    duration_ms: payload.durationMs,
    tokens_in: payload.tokensIn,
    tokens_out: payload.tokensOut,
    timestamp,
    error: payload.error,
  });
  emitStageTelemetry({
    turn,
    stage,
    payload,
  });
  updatePacketTelemetry(turn);
}

function coerceForcedAnswer(text: string, stageResult: StageResult): StageResult {
  if (stageResult.decision === "answer" && stageResult.answer?.trim()) {
    return stageResult;
  }
  const rendered =
    stageResult.answer?.trim() ||
    renderStructuredValue({ output: stripTurnMarker(text).trim() }, "answer");
  return {
    decision: "answer",
    reason: "forced_answer_at_terminal_stage",
    statusMessage: "Returning the best available response from the final reasoning stage.",
    answer: rendered.trim(),
  };
}

async function attemptForcedAnswerAtTerminalStage(params: {
  turn: RouterTurnState;
  stage: ResolvedStageDefinition;
  stageIndex: number;
  emitStageTelemetry: StageTelemetryEmitter;
}): Promise<StageResult | null> {
  appendLedgerEntry(params.turn.packet, {
    stage: params.stage.id,
    kind: "semantic_stage_policy",
    decision: "answer",
    reason: "force_answer_retry",
    duration_ms: 0,
    tokens_in: 0,
    tokens_out: 0,
    timestamp: nowIso(),
  });
  try {
    const forcedCall = await callStageModel(params.turn, params.stage, { forceAnswer: true });
    const forcedStageResult = coerceForcedAnswer(
      forcedCall.text,
      resolveStageResult(forcedCall.text, params.stageIndex, params.turn.config),
    );
    recordStageTelemetry(params.turn, params.stage, {
      decision: forcedStageResult.decision,
      reason: forcedStageResult.reason,
      durationMs: forcedCall.durationMs,
      tokensIn: forcedCall.tokensIn,
      tokensOut: forcedCall.tokensOut,
      rawContent: forcedCall.text,
    }, params.emitStageTelemetry);
    params.turn.budgetUsed += forcedCall.tokensIn + forcedCall.tokensOut;
    return forcedStageResult;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    recordStageTelemetry(params.turn, params.stage, {
      decision: "failed",
      reason: "force_answer_retry_failed",
      durationMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      rawContent: errorMessage,
      error: errorMessage,
    }, params.emitStageTelemetry);
    return null;
  }
}

export async function executeProviderRouteTurn(params: {
  turn: RouterTurnState;
  emitStageTelemetry: StageTelemetryEmitter;
}): Promise<void> {
  const { turn, emitStageTelemetry } = params;
  if (turn.finalResponse) {
    return;
  }

  for (let stageIndex = 0; stageIndex < turn.config.stages.length; stageIndex += 1) {
    const stage = setCurrentStage(turn.packet, stageIndex, turn.config);
    if (stageIndex === 0) {
      const complexity = assessPromptComplexity(turn.prompt);
      if (complexity.score >= 2) {
        const { nextStageId } = canAdvanceStage(turn, stageIndex, stage);
        appendLedgerEntry(turn.packet, {
          stage: stage.id,
          kind: "semantic_stage_policy",
          decision: "escalate",
          reason: "local_complexity_bypass",
          override_signals: complexity.signals,
          override_score: complexity.score,
          duration_ms: 0,
          tokens_in: 0,
          tokens_out: 0,
          timestamp: nowIso(),
        });
        const routing = asObject(turn.packet.routing);
        routing.current_stage = stage.id;
        routing.next_stage = nextStageId;
        routing.stage_index = stageIndex + 1;
        turn.packet.routing = routing;
        continue;
      }
    }

    const stageStartedAt = Date.now();
    let stageCall;
    try {
      stageCall = await callStageModel(turn, stage);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const durationMs = Math.max(Date.now() - stageStartedAt, 0);
      recordStageTelemetry(turn, stage, {
        decision: "failed",
        reason: "stage_execution_failed",
        durationMs,
        tokensIn: 0,
        tokensOut: 0,
        rawContent: errorMessage,
        error: errorMessage,
      }, emitStageTelemetry);
      const { nextStageId, allowedTransition, depthExhausted, overBudget } = canAdvanceStage(turn, stageIndex, stage);
      if (turn.config.guardrails.forceAnswerAtMaxDepth && stage.allowedNext.length === 0) {
        const forcedStageResult = await attemptForcedAnswerAtTerminalStage({
          turn,
          stage,
          stageIndex,
          emitStageTelemetry,
        });
        if (forcedStageResult?.answer?.trim()) {
          finalizeTurn(turn, {
            status: "answer",
            reason: forcedStageResult.reason,
            statusMessage: forcedStageResult.statusMessage,
            answer: forcedStageResult.answer,
          });
          return;
        }
      }
      if (allowedTransition && !depthExhausted && !overBudget) {
        appendLedgerEntry(turn.packet, {
          stage: stage.id,
          kind: "semantic_stage_recovery",
          decision: "escalate",
          reason: "stage_execution_failed_recovered",
          next_stage: nextStageId,
          duration_ms: 0,
          tokens_in: 0,
          tokens_out: 0,
          timestamp: nowIso(),
        });
        const routing = asObject(turn.packet.routing);
        routing.current_stage = stage.id;
        routing.next_stage = nextStageId;
        routing.stage_index = stageIndex + 1;
        turn.packet.routing = routing;
        continue;
      }
      finalizeTurn(turn, {
        status: "failed",
        reason: "stage_execution_failed",
        statusMessage: "A Semantic Router stage failed during provider execution and no further escalation path was available.",
        error: errorMessage,
      });
      return;
    }

    const stageResult = resolveStageResult(stageCall.text, stageIndex, turn.config);
    if (stageIndex === 0 && stageResult.decision === "answer") {
      const complexity = assessPromptComplexity(turn.prompt);
      const answerTokens = approximateTokens(stageResult.answer);
      if (complexity.score >= 2 && answerTokens >= 180) {
        appendLedgerEntry(turn.packet, {
          stage: stage.id,
          kind: "semantic_stage_policy",
          decision: "escalate",
          reason: "local_complexity_override",
          override_signals: complexity.signals,
          override_score: complexity.score,
          duration_ms: 0,
          tokens_in: 0,
          tokens_out: 0,
          timestamp: nowIso(),
        });
        stageResult.decision = "escalate";
        stageResult.reason = "local_complexity_override";
        stageResult.statusMessage = "Escalating because the request exceeds the local-first reasoning budget.";
        delete stageResult.answer;
      }
    }

    recordStageTelemetry(turn, stage, {
      decision: stageResult.decision,
      reason: stageResult.reason,
      durationMs: stageCall.durationMs,
      tokensIn: stageCall.tokensIn,
      tokensOut: stageCall.tokensOut,
      rawContent: stageCall.text,
    }, emitStageTelemetry);
    turn.budgetUsed += stageCall.tokensIn + stageCall.tokensOut;
    const { nextStageId, allowedTransition, depthExhausted, overBudget } = canAdvanceStage(turn, stageIndex, stage);

    if (stageResult.decision === "answer") {
      finalizeTurn(turn, {
        status: "answer",
        reason: stageResult.reason,
        statusMessage: stageResult.statusMessage,
        answer: stageResult.answer ?? "",
      });
      break;
    }

    if (stageResult.decision === "spawn_agent") {
      if (turn.config.guardrails.forceAnswerAtMaxDepth && stage.allowedNext.length === 0 && !shouldSkipForcedAnswerRetry(stageResult)) {
        const forcedStageResult = await attemptForcedAnswerAtTerminalStage({
          turn,
          stage,
          stageIndex,
          emitStageTelemetry,
        });
        if (forcedStageResult?.answer?.trim()) {
          finalizeTurn(turn, {
            status: "answer",
            reason: forcedStageResult.reason,
            statusMessage: forcedStageResult.statusMessage,
            answer: forcedStageResult.answer,
          });
          break;
        }
      }
      if (!(turn.config.guardrails.allowSpawnAgent && stage.allowSpawnAgent)) {
        finalizeTurn(turn, {
          status: "failed",
          reason: "spawn_agent_disallowed",
          statusMessage: "Workflow dispatch is not permitted for this request.",
          error: "spawn_agent_disallowed",
        });
      } else {
        finalizeTurn(turn, {
          status: "spawn_agent",
          reason: stageResult.reason,
          statusMessage: stageResult.statusMessage || "Dispatching workflow.",
          agentTarget: stageResult.agentTarget ?? "agent_router_pending",
        });
      }
      break;
    }

    if (stageResult.decision !== "escalate") {
      finalizeTurn(turn, {
        status: "failed",
        reason: "invalid_stage_decision",
        statusMessage: "Semantic Router returned an invalid stage decision.",
        error: "invalid_stage_decision",
      });
      break;
    }

    if (!allowedTransition || overBudget || depthExhausted) {
      if (turn.config.guardrails.forceAnswerAtMaxDepth) {
        if (!overBudget && depthExhausted) {
          const forcedStageResult = await attemptForcedAnswerAtTerminalStage({
            turn,
            stage,
            stageIndex,
            emitStageTelemetry,
          });
          if (forcedStageResult?.answer?.trim()) {
            finalizeTurn(turn, {
              status: "answer",
              reason: forcedStageResult.reason,
              statusMessage: forcedStageResult.statusMessage,
              answer: forcedStageResult.answer,
            });
            break;
          }
        }
        finalizeTurn(turn, {
          status: "answer",
          reason: overBudget ? "budget_exhausted" : "escalation_limit_reached",
          statusMessage: "Returning the best available response within the configured reasoning budget.",
          answer:
            stageResult.answer?.trim() ||
            `I could not escalate further within the configured semantic router guardrails. (${overBudget ? "budget_exhausted" : "escalation_limit_reached"})`,
        });
      } else {
        finalizeTurn(turn, {
          status: "failed",
          reason: "escalation_blocked",
          statusMessage: "Escalation was blocked by router guardrails.",
          error: "escalation_blocked",
        });
      }
      break;
    }

    const routing = asObject(turn.packet.routing);
    routing.current_stage = stage.id;
    routing.next_stage = nextStageId;
    routing.stage_index = stageIndex + 1;
    turn.packet.routing = routing;
  }

  if (!turn.finalResponse) {
    finalizeTurn(turn, {
      status: "failed",
      reason: "semantic_router_missing_terminal_state",
      statusMessage: "Semantic Router did not reach a terminal state.",
      error: "semantic_router_missing_terminal_state",
    });
  }
}

export async function writeDebugArtifact(pluginConfig: PluginConfig, turn: RouterTurnState, durationMs?: number): Promise<void> {
  await fs.mkdir(pluginConfig.debugDir, { recursive: true });
  const telemetry = asObject(computeTelemetry(turn));
  telemetry.total_duration_ms = Number(durationMs ?? telemetry.total_duration_ms ?? 0);
  const payload = {
    turn_id: turn.turnId,
    root_session_id: turn.rootSessionId,
    root_session_key: turn.rootSessionKey ?? null,
    prompt: turn.prompt,
    packet: turn.packet,
    telemetry,
    stages: turn.telemetry,
    final_response: turn.finalResponse ?? null,
    provider_run_id: turn.providerRunId ?? null,
    written_at: nowIso(),
  };
  const latestPath = path.join(pluginConfig.debugDir, `${sanitizeFileName(turn.rootSessionId)}.json`);
  const turnPath = path.join(pluginConfig.debugDir, `${sanitizeFileName(turn.rootSessionId)}__${sanitizeFileName(turn.turnId)}.json`);
  const serialized = JSON.stringify(payload, null, 2) + "\n";
  await Promise.all([
    fs.writeFile(latestPath, serialized, "utf-8"),
    fs.writeFile(turnPath, serialized, "utf-8"),
  ]);
}
