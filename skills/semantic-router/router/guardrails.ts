import type { ResolvedStageDefinition, RouterTurnState, StageResult } from "./types.js";

export function approximateTokens(text: string | undefined): number {
  const value = String(text ?? "").trim();
  if (!value) {
    return 0;
  }
  return Math.max(Math.ceil(value.length / 4), 1);
}

export function assessPromptComplexity(prompt: string): { score: number; signals: string[] } {
  const signals: string[] = [];
  const trimmed = prompt.trim();
  const tokenEstimate = approximateTokens(trimmed);
  const nonEmptyLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (tokenEstimate >= 180) {
    signals.push("prompt_tokens_high");
  }
  if (nonEmptyLines.length >= 12) {
    signals.push("structured_multiline_request");
  }

  const requirementLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /^[-*]/.test(line) || /^(requirements|constraints|explain|include)\b/i.test(line));
  if (requirementLines.length >= 4) {
    signals.push("many_explicit_requirements");
  }

  let decomposedSubtasks = 0;
  for (let index = 0; index < nonEmptyLines.length; index += 1) {
    if (!nonEmptyLines[index]?.endsWith(":")) {
      continue;
    }
    let nestedIndex = index + 1;
    while (
      nestedIndex < nonEmptyLines.length &&
      /^(what|how|why|when|where|which|compare|provide|include|list|explain)\b/i.test(nonEmptyLines[nestedIndex] ?? "")
    ) {
      decomposedSubtasks += 1;
      nestedIndex += 1;
    }
  }
  if (decomposedSubtasks >= 3) {
    signals.push("decomposed_subtasks");
  }

  const keywordPatterns = [
    /\bpseudocode\b/i,
    /\balgorithm\b/i,
    /\btradeoffs?\b/i,
    /\bfailure modes?\b/i,
    /\bdesign\b/i,
    /\bstep-by-step\b/i,
    /\bweighted decision matrix\b/i,
    /\bcompare\b/i,
    /\brollback\b/i,
  ];
  const keywordHits = keywordPatterns.filter((pattern) => pattern.test(trimmed)).length;
  if (keywordHits >= 2) {
    signals.push("complex_reasoning_keywords");
  }

  if ((trimmed.match(/\?/g) ?? []).length >= 3) {
    signals.push("multiple_subquestions");
  }

  return {
    score: signals.length,
    signals,
  };
}

export function stageExecutionSettings(
  turn: RouterTurnState,
  stage: ResolvedStageDefinition,
  options?: { forceAnswer?: boolean },
): { maxTokens: number; temperature: number; timeoutMs: number } {
  if (options?.forceAnswer) {
    return {
      maxTokens: 8192,
      temperature: 0,
      timeoutMs: Math.max(turn.config.guardrails.stageTimeoutMs * 4, 180000),
    };
  }
  if (stage.promptProfile === "local") {
    return { maxTokens: 256, temperature: 0, timeoutMs: Math.min(turn.config.guardrails.stageTimeoutMs, 10000) };
  }
  if (stage.promptProfile === "reasoning") {
    return { maxTokens: 2048, temperature: 0, timeoutMs: turn.config.guardrails.stageTimeoutMs };
  }
  if (stage.promptProfile === "thinking") {
    return {
      maxTokens: 8192,
      temperature: 0,
      timeoutMs: Math.max(turn.config.guardrails.stageTimeoutMs * 3, 150000),
    };
  }
  return { maxTokens: 1024, temperature: 0, timeoutMs: turn.config.guardrails.stageTimeoutMs };
}

export function canAdvanceStage(
  turn: RouterTurnState,
  stageIndex: number,
  stage: ResolvedStageDefinition,
): {
  nextStageId: string | null;
  allowedTransition: boolean;
  depthExhausted: boolean;
  overBudget: boolean;
} {
  const nextStageId = turn.config.stages[stageIndex + 1]?.id ?? null;
  return {
    nextStageId,
    allowedTransition: Boolean(nextStageId && stage.allowedNext.includes(nextStageId)),
    depthExhausted:
      stageIndex >= Math.min(turn.config.guardrails.maxEscalationDepth, turn.config.stages.length - 1) ||
      stageIndex + 1 >= turn.config.stages.length,
    overBudget:
      turn.config.guardrails.requestBudgetCap > 0 &&
      turn.budgetUsed >= turn.config.guardrails.requestBudgetCap,
  };
}

export function shouldSkipForcedAnswerRetry(stageResult: StageResult): boolean {
  const agentTarget = String(stageResult.agentTarget ?? "").trim().toLowerCase();
  const combinedReason = `${stageResult.reason} ${stageResult.statusMessage}`.toLowerCase();
  if (agentTarget.includes("code") || agentTarget.includes("python") || agentTarget.includes("calculator")) {
    return true;
  }
  return (
    combinedReason.includes("guarantee correctness") ||
    combinedReason.includes("deterministic") ||
    combinedReason.includes("exact simulation") ||
    combinedReason.includes("code execution")
  );
}
