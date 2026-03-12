export type StageDecision = "answer" | "escalate" | "spawn_agent";

export type PluginConfig = {
  routerConfigPath: string;
  debugDir: string;
  responseFooter: "off" | "concise";
};

export type StageDefinition = {
  id: string;
  provider: string;
  model?: string;
  modelEnv?: string;
  fallbackModel?: string;
  promptProfile: string;
  allowedNext: string[];
  allowSpawnAgent: boolean;
  baseUrl?: string;
  baseUrlEnv?: string;
  apiKeyEnv?: string;
};

export type ResolvedStageDefinition = {
  id: string;
  provider: string;
  model: string;
  modelRef: string;
  promptProfile: string;
  allowedNext: string[];
  allowSpawnAgent: boolean;
  baseUrl?: string;
  apiKeyEnv?: string;
};

export type Guardrails = {
  maxEscalationDepth: number;
  forceAnswerAtMaxDepth: boolean;
  allowSpawnAgent: boolean;
  stageTimeoutMs: number;
  requestBudgetCap: number;
};

export type SemanticRouterConfig = {
  requesterDefaults: Record<string, string>;
  guardrails: Guardrails;
  stages: ResolvedStageDefinition[];
};

export type StageResult = {
  decision: StageDecision;
  reason: string;
  statusMessage: string;
  answer?: string;
  agentTarget?: string;
};

export type StageCallResult = {
  text: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
};

export type StageTelemetry = {
  runId?: string;
  stage: string;
  provider: string;
  model: string;
  decision: string;
  reason: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  timestamp: string;
  rawContent?: string;
};

export type FinalResponse = {
  status: "answer" | "spawn_agent" | "failed";
  reason: string;
  statusMessage: string;
  answer?: string;
  agentTarget?: string;
  error?: string;
};

export type RouterTurnState = {
  turnId: string;
  rootSessionId: string;
  rootSessionKey?: string;
  prompt: string;
  packet: Record<string, unknown>;
  config: SemanticRouterConfig;
  startedAt: number;
  budgetUsed: number;
  telemetry: StageTelemetry[];
  finalResponse?: FinalResponse;
  providerRunId?: string;
};

export type StageTelemetryPayload = {
  runId?: string;
  provider?: string;
  model?: string;
  decision: string;
  reason: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  rawContent?: string;
  error?: string;
};

export type StageTelemetryEmitter = (params: {
  turn: RouterTurnState;
  stage: ResolvedStageDefinition;
  payload: StageTelemetryPayload;
}) => void;
