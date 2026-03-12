import fs from "node:fs/promises";
import { approximateTokens, stageExecutionSettings } from "./guardrails.js";
import type {
  ResolvedStageDefinition,
  RouterTurnState,
  SemanticRouterConfig,
  StageCallResult,
  StageDefinition,
  StageResult,
} from "./types.js";

function sleepMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

type ParsedYaml = Record<string, unknown> | unknown[];

function parseYamlBlock(lines: string[], startIndex: number, indent: number): [ParsedYaml, number] {
  const first = lines[startIndex] ?? "";
  const trimmedFirst = first.trim();
  if (trimmedFirst.startsWith("- ")) {
    const items: unknown[] = [];
    let index = startIndex;
    while (index < lines.length) {
      const line = lines[index] ?? "";
      const currentIndent = line.length - line.trimStart().length;
      const trimmed = line.trim();
      if (currentIndent < indent || !trimmed.startsWith("- ")) {
        break;
      }
      const rest = trimmed.slice(2).trim();
      if (!rest) {
        const [nested, nextIndex] = parseYamlBlock(lines, index + 1, currentIndent + 2);
        items.push(nested);
        index = nextIndex;
        continue;
      }
      const colonIndex = rest.indexOf(":");
      if (colonIndex !== -1) {
        const key = rest.slice(0, colonIndex).trim();
        const valuePart = rest.slice(colonIndex + 1).trim();
        const item: Record<string, unknown> = {};
        if (valuePart) {
          item[key] = parseScalar(valuePart);
          index += 1;
        } else {
          const [nestedValue, nextIndex] = parseYamlBlock(lines, index + 1, currentIndent + 4);
          item[key] = nestedValue;
          index = nextIndex;
        }
        while (index < lines.length) {
          const nextLine = lines[index] ?? "";
          const nextIndent = nextLine.length - nextLine.trimStart().length;
          const nextTrimmed = nextLine.trim();
          if (nextIndent < currentIndent + 2 || nextTrimmed.startsWith("- ")) {
            break;
          }
          const nextColon = nextTrimmed.indexOf(":");
          if (nextColon === -1) {
            index += 1;
            continue;
          }
          const nextKey = nextTrimmed.slice(0, nextColon).trim();
          const nextValuePart = nextTrimmed.slice(nextColon + 1).trim();
          if (nextValuePart) {
            item[nextKey] = parseScalar(nextValuePart);
            index += 1;
          } else {
            const [nestedValue, nextIndex] = parseYamlBlock(lines, index + 1, nextIndent + 2);
            item[nextKey] = nestedValue;
            index = nextIndex;
          }
        }
        items.push(item);
        continue;
      }
      items.push(parseScalar(rest));
      index += 1;
    }
    return [items, index];
  }

  const result: Record<string, unknown> = {};
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const currentIndent = line.length - line.trimStart().length;
    if (currentIndent < indent) {
      break;
    }
    if (currentIndent > indent) {
      index += 1;
      continue;
    }
    const trimmed = line.trim();
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      index += 1;
      continue;
    }
    const key = trimmed.slice(0, colonIndex).trim();
    const valuePart = trimmed.slice(colonIndex + 1).trim();
    if (valuePart) {
      result[key] = parseScalar(valuePart);
      index += 1;
      continue;
    }
    const [nested, nextIndex] = parseYamlBlock(lines, index + 1, indent + 2);
    result[key] = nested;
    index = nextIndex;
  }
  return [result, index];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

async function readStructuredFile(filePath: string): Promise<Record<string, unknown>> {
  const text = await fs.readFile(filePath, "utf-8");
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return asObject(JSON.parse(trimmed));
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, "    "))
    .filter((line) => {
      const compact = line.trim();
      return Boolean(compact) && !compact.startsWith("#");
    });
  if (!lines.length) {
    return {};
  }
  const [parsed] = parseYamlBlock(lines, 0, 0);
  return asObject(parsed);
}

function resolveStage(rawStage: StageDefinition, index: number, rawStages: StageDefinition[]): ResolvedStageDefinition {
  const model = String(rawStage.model ?? "").trim() ||
    String(rawStage.modelEnv ? process.env[rawStage.modelEnv] ?? "" : "").trim() ||
    String(rawStage.fallbackModel ?? "").trim();
  if (!model) {
    throw new Error(`semantic router stage '${rawStage.id || `stage_${index}`}' could not resolve a model`);
  }
  const provider = String(rawStage.provider ?? "").trim();
  if (!provider) {
    throw new Error(`semantic router stage '${rawStage.id || `stage_${index}`}' requires a provider`);
  }
  const defaultNext = rawStages[index + 1]?.id ? [rawStages[index + 1]!.id] : [];
  return {
    id: String(rawStage.id || `stage_${index}`).trim(),
    provider,
    model,
    modelRef: `${provider}/${model}`,
    promptProfile: String(rawStage.promptProfile || rawStage.id || `stage_${index}`).trim(),
    allowedNext:
      rawStage.allowedNext.length > 0
        ? rawStage.allowedNext.map((value) => String(value).trim()).filter(Boolean)
        : defaultNext,
    allowSpawnAgent: Boolean(rawStage.allowSpawnAgent),
    baseUrl:
      String(rawStage.baseUrl ?? "").trim() ||
      String(rawStage.baseUrlEnv ? process.env[rawStage.baseUrlEnv] ?? "" : "").trim() ||
      undefined,
    apiKeyEnv: String(rawStage.apiKeyEnv ?? "").trim() || undefined,
  };
}

export async function loadSemanticRouterConfig(filePath: string): Promise<SemanticRouterConfig> {
  const rawFile = await readStructuredFile(filePath);
  const rawGuardrails = asObject(rawFile.guardrails);
  const rawStages = asArray<Record<string, unknown>>(rawFile.stages).map((item, index) => ({
    id: String(item.id ?? `stage_${index}`).trim(),
    provider: String(item.provider ?? "").trim(),
    model: typeof item.model === "string" ? item.model : undefined,
    modelEnv: typeof item.modelEnv === "string" ? item.modelEnv : undefined,
    fallbackModel: typeof item.fallbackModel === "string" ? item.fallbackModel : undefined,
    promptProfile: String(item.promptProfile ?? item.prompt_profile ?? item.id ?? `stage_${index}`).trim(),
    allowedNext: asArray<string>(item.allowedNext ?? item.allowed_next).map((value) => String(value)),
    allowSpawnAgent: Boolean(item.allowSpawnAgent ?? item.allow_spawn_agent),
    baseUrl: typeof item.baseUrl === "string" ? item.baseUrl : undefined,
    baseUrlEnv: typeof item.baseUrlEnv === "string" ? item.baseUrlEnv : undefined,
    apiKeyEnv: typeof item.apiKeyEnv === "string" ? item.apiKeyEnv : undefined,
  })) satisfies StageDefinition[];

  if (rawStages.length === 0) {
    throw new Error("semantic router config defines no stages");
  }

  return {
    requesterDefaults: Object.fromEntries(
      Object.entries(asObject(rawFile.requesterDefaults ?? rawFile.requester_defaults)).map(([key, value]) => [
        key,
        String(value),
      ]),
    ),
    guardrails: {
      maxEscalationDepth: Math.max(Number(rawGuardrails.maxEscalationDepth ?? rawGuardrails.max_escalation_depth ?? 0), 0),
      forceAnswerAtMaxDepth: Boolean(rawGuardrails.forceAnswerAtMaxDepth ?? rawGuardrails.force_answer_at_max_depth ?? true),
      allowSpawnAgent: Boolean(rawGuardrails.allowSpawnAgent ?? rawGuardrails.allow_spawn_agent ?? true),
      stageTimeoutMs: Math.max(Number(rawGuardrails.stageTimeoutMs ?? rawGuardrails.stage_timeout_ms ?? 30000), 1),
      requestBudgetCap: Math.max(Number(rawGuardrails.requestBudgetCap ?? rawGuardrails.request_budget_cap ?? 0), 0),
    },
    stages: rawStages.map((stage, index, stages) => resolveStage(stage, index, stages)),
  };
}

export function stagePrompt(stage: ResolvedStageDefinition, options?: { forceAnswer?: boolean }): string {
  const baseRules = [
    "You are a Remram Semantic Router stage running inside OpenClaw.",
    "Return only a JSON object with keys decision, reason, status_message, answer, and agent_target.",
    'The required output schema is: {"decision":"answer|escalate|spawn_agent","reason":"short string","status_message":"optional string","answer":"string or omitted","agent_target":"string or omitted"}.',
    "Valid decision values are answer, escalate, and spawn_agent.",
    "Set answer only when decision=answer.",
    "Set agent_target only when decision=spawn_agent.",
    "The answer field must contain the final user-visible answer as normal prose or markdown, not a top-level JSON object.",
    "If the user asks for pseudocode or structured explanation, place that formatted content inside the answer string.",
    "Do not return custom top-level keys like algorithm, pseudocode, signals, or tradeoffs outside the required contract.",
    "Do not include any keys other than decision, reason, status_message, answer, and agent_target.",
    "Do not wrap the JSON object in markdown fences.",
    "If you violate the contract, the orchestrator will treat the output as malformed and may escalate or recover automatically.",
    "Do not emit markdown fences, tool calls, or hidden reasoning.",
    "Do not call tools.",
    `Current stage id: ${stage.id}.`,
    `Current stage model: ${stage.modelRef}.`,
  ];

  if (!stage.allowSpawnAgent) {
    baseRules.push(
      "This stage is not allowed to return spawn_agent.",
      "If the request exceeds this stage, return escalate instead of spawn_agent.",
    );
  }

  if (stage.allowedNext.length === 0) {
    baseRules.push(
      "This is the terminal synchronous reasoning stage.",
      "There is no higher synchronous reasoning model available after this stage.",
      "Do not return escalate from this stage.",
      "Return answer unless this request truly must become an asynchronous workflow and spawn_agent is allowed.",
    );
  }

  if (stage.promptProfile === "local") {
    baseRules.push(
      "You are the cheapest local-first stage. Answer directly when the request is simple and bounded.",
      "If you are uncertain whether the request is too broad or would benefit from a stronger model, choose escalate immediately.",
      "Do not spend time producing a long partial solution when escalation is appropriate.",
      "Prefer a short escalate decision over a long speculative or incomplete answer.",
      "If the request likely needs substantial reasoning, synthesis, planning, design work, or an answer longer than a short direct response, escalate immediately.",
      "Escalate when the request needs broader synthesis, deeper reasoning, or a stronger model tier.",
      "Escalate for multi-part design tasks, algorithm design, pseudocode requests, tradeoff analysis, failure-mode analysis, or requests with many explicit requirements.",
    );
  } else if (stage.promptProfile === "reasoning") {
    baseRules.push(
      "You are the general cloud reasoning stage. Prefer answering once the request is resolved clearly.",
      "Escalate only when the request still exceeds the current reasoning tier.",
    );
  } else if (stage.promptProfile === "thinking") {
    baseRules.push(
      "You are the deepest synchronous reasoning stage. You are expected to produce the final synchronous answer.",
      "Use spawn_agent only when the request is better handled as an asynchronous workflow.",
    );
  }

  if (options?.forceAnswer) {
    baseRules.push(
      "Forced-answer mode is active.",
      "You must return decision='answer' with your best final answer.",
      "Do not return escalate.",
      "Do not return spawn_agent.",
      "Do not refuse solely because the task is difficult.",
      "The answer field must be non-empty.",
      "Keep the answer as short and direct as possible while remaining correct.",
      "Do not include lengthy reasoning or step-by-step derivations unless the user explicitly asked for them.",
      "If the user asked for exactness, compute carefully and provide the exact result you can derive.",
    );
  }

  return baseRules.join(" ");
}

type ProviderRouteMessage = {
  role: string;
  content: string;
};

function buildStageMessages(
  turn: RouterTurnState,
  stage: ResolvedStageDefinition,
  options?: { forceAnswer?: boolean },
): ProviderRouteMessage[] {
  return [
    {
      role: "system",
      content: stagePrompt(stage, options),
    },
    {
      role: "user",
      content: turn.prompt,
    },
  ];
}

function humanizeKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : key;
}

function renderStructuredArrayItem(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderStructuredArrayItem(item)).filter(Boolean).join("; ");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nestedValue]) => {
        const rendered = renderStructuredValue(nestedValue, key);
        if (!rendered) {
          return "";
        }
        return rendered.includes("\n")
          ? `${humanizeKey(key)}\n${rendered}`
          : `${humanizeKey(key)}: ${rendered}`;
      })
      .filter(Boolean)
      .join("; ");
  }
  return String(value);
}

export function renderStructuredValue(value: unknown, label?: string): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    const lowerLabel = String(label ?? "").toLowerCase();
    if (trimmed.includes("\n") || lowerLabel.includes("code") || lowerLabel.includes("pseudocode")) {
      return `\`\`\`\n${trimmed}\n\`\`\``;
    }
    return trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => renderStructuredArrayItem(item))
      .filter(Boolean)
      .map((item) => `- ${item}`)
      .join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nestedValue]) => {
        const rendered = renderStructuredValue(nestedValue, key);
        if (!rendered) {
          return "";
        }
        if (rendered.includes("\n")) {
          return `**${humanizeKey(key)}**\n${rendered}`;
        }
        return `**${humanizeKey(key)}**: ${rendered}`;
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(value);
}

function extractJsonFromText(text: string): Record<string, unknown> | null {
  const stripped = text.trim();
  if (!stripped) {
    return null;
  }
  const candidates = [stripped];
  if (stripped.includes("```")) {
    for (const chunk of stripped.split("```")) {
      let candidate = chunk.trim();
      if (!candidate) {
        continue;
      }
      if (candidate.toLowerCase().startsWith("json")) {
        candidate = candidate.slice(4).trim();
      }
      candidates.push(candidate);
    }
  }
  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(stripped.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore malformed candidates
    }
  }
  return null;
}

function extractJsonishStringField(text: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`"${escaped}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "s");
  const match = text.match(pattern);
  if (!match?.[1]) {
    return undefined;
  }
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

function extractPartialStageResult(text: string): StageResult | null {
  const decision = extractJsonishStringField(text, "decision");
  if (decision !== "answer" && decision !== "escalate" && decision !== "spawn_agent") {
    return null;
  }
  return {
    decision,
    reason: extractJsonishStringField(text, "reason") ?? "partial_json_stage_result",
    statusMessage: extractJsonishStringField(text, "status_message") ?? "",
    answer: decision === "answer" ? extractJsonishStringField(text, "answer") : undefined,
    agentTarget: decision === "spawn_agent" ? extractJsonishStringField(text, "agent_target") : undefined,
  };
}

function normalizeStageResult(text: string): StageResult {
  const parsed = extractJsonFromText(text);
  if (parsed) {
    const decision = String(parsed.decision ?? "").trim();
    if (decision === "answer" || decision === "escalate" || decision === "spawn_agent") {
      return {
        decision,
        reason: String(parsed.reason ?? "stage decision returned").trim(),
        statusMessage: String(parsed.status_message ?? "").trim(),
        answer:
          typeof parsed.answer === "string"
            ? parsed.answer.trim()
            : parsed.answer !== undefined
              ? renderStructuredValue(parsed.answer, "answer")
              : undefined,
        agentTarget: typeof parsed.agent_target === "string" ? parsed.agent_target.trim() : undefined,
      };
    }
    if (typeof parsed.answer === "string" && parsed.answer.trim()) {
      return {
        decision: "answer",
        reason: "fallback_answer_field",
        statusMessage: "",
        answer: parsed.answer.trim(),
      };
    }
  }
  const partial = extractPartialStageResult(text);
  if (partial) {
    return partial;
  }
  return {
    decision: "answer",
    reason: "fallback_raw_output",
    statusMessage: "",
    answer: text.trim(),
  };
}

function extractStructuredNonContractPayload(text: string): Record<string, unknown> | null {
  const parsed = extractJsonFromText(text);
  if (!parsed) {
    return null;
  }
  const decision = String(parsed.decision ?? "").trim();
  if (decision === "answer" || decision === "escalate" || decision === "spawn_agent") {
    return null;
  }
  if (typeof parsed.answer === "string" && parsed.answer.trim()) {
    return null;
  }
  return parsed;
}

function looksStructuredMarkup(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.toLowerCase().startsWith("```json") ||
    trimmed.toLowerCase().startsWith("```javascript") ||
    trimmed.toLowerCase().startsWith("```js")
  ) {
    return true;
  }
  return /"\w[\w-]*"\s*:/.test(trimmed);
}

function stripThinkTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^<think>[\s\S]*$/i, "")
    .trim();
}

function parseVisibleContractAfterThinkTags(text: string): StageResult | null {
  const visible = stripThinkTags(text);
  if (!visible || visible === text.trim()) {
    return null;
  }
  const parsed = extractJsonFromText(visible);
  if (parsed) {
    const decision = String(parsed.decision ?? "").trim();
    if (decision === "answer" || decision === "escalate" || decision === "spawn_agent") {
      return {
        decision,
        reason: String(parsed.reason ?? "visible_stage_result").trim(),
        statusMessage: String(parsed.status_message ?? "").trim(),
        answer:
          typeof parsed.answer === "string"
            ? parsed.answer.trim()
            : typeof parsed.output === "string"
              ? parsed.output.trim()
              : undefined,
        agentTarget: typeof parsed.agent_target === "string" ? parsed.agent_target.trim() : undefined,
      };
    }
  }
  return extractPartialStageResult(visible);
}

function looksMalformedRouterOutput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  return trimmed.startsWith("<think>") || trimmed.includes("</think>");
}

export function resolveStageResult(
  text: string,
  stageIndex: number,
  config: SemanticRouterConfig,
): StageResult {
  const visibleContract = parseVisibleContractAfterThinkTags(text);
  if (visibleContract) {
    return visibleContract;
  }
  if (looksMalformedRouterOutput(text)) {
    const visible = stripThinkTags(text);
    if (stageIndex + 1 < config.stages.length || !visible) {
      return {
        decision: "escalate",
        reason: "stage_contract_violation",
        statusMessage: "Escalating because the current stage returned malformed router output.",
      };
    }
    return {
      decision: "answer",
      reason: "malformed_output_salvaged",
      statusMessage: "Recovered the visible portion of the final stage output.",
      answer: visible,
    };
  }

  const structuredNonContractPayload = extractStructuredNonContractPayload(text);
  if (structuredNonContractPayload) {
    if (stageIndex + 1 < config.stages.length) {
      return {
        decision: "escalate",
        reason: "stage_contract_violation",
        statusMessage: "Escalating because the current stage returned malformed router output.",
      };
    }
    return {
      decision: "answer",
      reason: "structured_answer_salvaged",
      statusMessage: "Recovered a structured answer from the final stage.",
      answer: renderStructuredValue(structuredNonContractPayload),
    };
  }

  const stageResult = normalizeStageResult(text);
  if (stageResult.reason === "fallback_raw_output" && looksStructuredMarkup(text)) {
    if (stageIndex + 1 < config.stages.length) {
      return {
        decision: "escalate",
        reason: "stage_contract_violation",
        statusMessage: "Escalating because the current stage returned structured markup instead of the router contract.",
      };
    }
    return {
      decision: "answer",
      reason: "structured_markup_salvaged",
      statusMessage: "Recovered the final stage output after a router contract violation.",
      answer: renderStructuredValue(extractJsonFromText(text) ?? { output: text.trim() }),
    };
  }

  return stageResult;
}

async function callOllamaStage(
  turn: RouterTurnState,
  stage: ResolvedStageDefinition,
  options?: { forceAnswer?: boolean },
): Promise<StageCallResult> {
  const startedAt = Date.now();
  const execution = stageExecutionSettings(turn, stage, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), execution.timeoutMs);
  try {
    const response = await fetch(stage.baseUrl ?? "http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: stage.model,
        messages: buildStageMessages(turn, stage, options),
        stream: false,
        options: {
          num_predict: execution.maxTokens,
          temperature: execution.temperature,
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`ollama_stage_failed:${response.status}`);
    }
    const payload = asObject(await response.json());
    const message = asObject(payload.message);
    const text = typeof message.content === "string" ? message.content.trim() : "";
    return {
      text,
      tokensIn: Number(payload.prompt_eval_count ?? approximateTokens(turn.prompt)),
      tokensOut: Number(payload.eval_count ?? approximateTokens(text)),
      durationMs: Math.max(Date.now() - startedAt, 0),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callTogetherStage(
  turn: RouterTurnState,
  stage: ResolvedStageDefinition,
  options?: { forceAnswer?: boolean },
): Promise<StageCallResult> {
  const apiKey = String(stage.apiKeyEnv ? process.env[stage.apiKeyEnv] ?? "" : process.env.TOGETHER_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("together_api_key_missing");
  }
  const startedAt = Date.now();
  const execution = stageExecutionSettings(turn, stage, options);
  const deadline = startedAt + execution.timeoutMs;
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt < 3) {
    attempt += 1;
    const remainingMs = Math.max(deadline - Date.now(), 1);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    try {
      const response = await fetch(stage.baseUrl ?? "https://api.together.xyz/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: stage.model,
          messages: buildStageMessages(turn, stage, options),
          stream: false,
          max_tokens: execution.maxTokens,
          temperature: execution.temperature,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorText = await response.text();
        const retryable = response.status === 429 || response.status >= 500;
        lastError = new Error(`together_stage_failed:${response.status}:${errorText}`);
        const backoffMs = attempt * 750;
        if (retryable && attempt < 3 && Date.now() + backoffMs < deadline) {
          await sleepMs(backoffMs);
          continue;
        }
        throw lastError;
      }
      const payload = asObject(await response.json());
      const choices = asArray<Record<string, unknown>>(payload.choices);
      const firstChoice = asObject(choices[0]);
      const message = asObject(firstChoice.message);
      const text = typeof message.content === "string" ? message.content.trim() : "";
      const usage = asObject(payload.usage);
      return {
        text,
        tokensIn: Number(usage.prompt_tokens ?? approximateTokens(turn.prompt)),
        tokensOut: Number(usage.completion_tokens ?? approximateTokens(text)),
        durationMs: Math.max(Date.now() - startedAt, 0),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = error instanceof Error ? error : new Error(message);
      const retryableNetworkError =
        message.includes("fetch failed") || message.includes("ECONNRESET") || message.includes("ENOTFOUND");
      const retryableAbort = message.includes("AbortError");
      const backoffMs = attempt * 750;
      if ((retryableNetworkError || retryableAbort) && attempt < 3 && Date.now() + backoffMs < deadline) {
        await sleepMs(backoffMs);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("together_stage_failed:retry_exhausted");
}

export async function callStageModel(
  turn: RouterTurnState,
  stage: ResolvedStageDefinition,
  options?: { forceAnswer?: boolean },
): Promise<StageCallResult> {
  if (stage.provider === "ollama") {
    return callOllamaStage(turn, stage, options);
  }
  if (stage.provider === "together") {
    return callTogetherStage(turn, stage, options);
  }
  throw new Error(`unsupported_semantic_router_provider:${stage.provider}`);
}
