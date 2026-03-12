import assert from "node:assert/strict";
import test from "node:test";
import { executeProviderRouteTurn, finalVisibleText, hydrateRequestPacket } from "./index.js";
import type { ResolvedStageDefinition, RouterTurnState, SemanticRouterConfig, StageTelemetryEmitter } from "./types.js";

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function stage(params: Partial<ResolvedStageDefinition> & Pick<ResolvedStageDefinition, "id" | "provider" | "model">): ResolvedStageDefinition {
  return {
    id: params.id,
    provider: params.provider,
    model: params.model,
    modelRef: `${params.provider}/${params.model}`,
    promptProfile: params.promptProfile ?? params.id,
    allowedNext: params.allowedNext ?? [],
    allowSpawnAgent: params.allowSpawnAgent ?? false,
    baseUrl: params.baseUrl,
    apiKeyEnv: params.apiKeyEnv,
  };
}

function config(stages: ResolvedStageDefinition[]): SemanticRouterConfig {
  return {
    requesterDefaults: {
      user_id: "test-user",
      role: "owner",
    },
    guardrails: {
      maxEscalationDepth: Math.max(stages.length - 1, 0),
      forceAnswerAtMaxDepth: true,
      allowSpawnAgent: true,
      stageTimeoutMs: 1000,
      requestBudgetCap: 10000,
    },
    stages,
  };
}

function turn(prompt: string, routerConfig: SemanticRouterConfig): RouterTurnState {
  return {
    turnId: "turn-1",
    rootSessionId: "session-1",
    prompt,
    packet: hydrateRequestPacket(prompt, routerConfig, "session-1"),
    config: routerConfig,
    startedAt: Date.now(),
    budgetUsed: 0,
    telemetry: [],
  };
}

function recorder(events: Array<{ stage: string; decision: string; reason: string }>): StageTelemetryEmitter {
  return ({ stage: activeStage, payload }) => {
    events.push({
      stage: activeStage.id,
      decision: payload.decision,
      reason: payload.reason,
    });
  };
}

test("returns a local-stage answer without escalation", async (t) => {
  const routerConfig = config([
    stage({
      id: "local",
      provider: "ollama",
      model: "mock-local",
      promptProfile: "local",
      baseUrl: "http://local-stage.test/api/chat",
    }),
  ]);
  const activeTurn = turn("What is 2 + 2?", routerConfig);
  const events: Array<{ stage: string; decision: string; reason: string }> = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "http://local-stage.test/api/chat");
    assert.equal(init?.method, "POST");
    return jsonResponse({
      message: {
        content: JSON.stringify({
          decision: "answer",
          reason: "answered_locally",
          status_message: "Resolved by the local stage.",
          answer: "4",
        }),
      },
      prompt_eval_count: 9,
      eval_count: 3,
    });
  };

  await executeProviderRouteTurn({
    turn: activeTurn,
    emitStageTelemetry: recorder(events),
  });

  assert.equal(activeTurn.finalResponse?.status, "answer");
  assert.equal(activeTurn.finalResponse?.answer, "4");
  assert.equal(finalVisibleText(activeTurn, "off"), "4");
  assert.equal(activeTurn.telemetry.length, 1);
  assert.deepEqual(events, [
    {
      stage: "local",
      decision: "answer",
      reason: "answered_locally",
    },
  ]);
});

test("escalates from local to reasoning and records both stages", async (t) => {
  const priorApiKey = process.env.TOGETHER_API_KEY;
  process.env.TOGETHER_API_KEY = "test-key";
  t.after(() => {
    if (priorApiKey === undefined) {
      delete process.env.TOGETHER_API_KEY;
    } else {
      process.env.TOGETHER_API_KEY = priorApiKey;
    }
  });

  const routerConfig = config([
    stage({
      id: "local",
      provider: "ollama",
      model: "mock-local",
      promptProfile: "local",
      allowedNext: ["reasoning"],
      baseUrl: "http://local-stage.test/api/chat",
    }),
    stage({
      id: "reasoning",
      provider: "together",
      model: "mock-reasoning",
      promptProfile: "reasoning",
      baseUrl: "http://reasoning-stage.test/v1/chat/completions",
      apiKeyEnv: "TOGETHER_API_KEY",
    }),
  ]);
  const activeTurn = turn("Summarize the implications of this design.", routerConfig);
  const events: Array<{ stage: string; decision: string; reason: string }> = [];
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input) => {
    callCount += 1;
    if (String(input) === "http://local-stage.test/api/chat") {
      return jsonResponse({
        message: {
          content: JSON.stringify({
            decision: "escalate",
            reason: "needs_reasoning",
            status_message: "Escalating to the reasoning stage.",
          }),
        },
        prompt_eval_count: 12,
        eval_count: 5,
      });
    }
    assert.equal(String(input), "http://reasoning-stage.test/v1/chat/completions");
    return jsonResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              decision: "answer",
              reason: "resolved",
              status_message: "Resolved by reasoning.",
              answer: "Reasoning stage answer.",
            }),
          },
        },
      ],
      usage: {
        prompt_tokens: 22,
        completion_tokens: 8,
      },
    });
  };

  await executeProviderRouteTurn({
    turn: activeTurn,
    emitStageTelemetry: recorder(events),
  });

  assert.equal(callCount, 2);
  assert.equal(activeTurn.finalResponse?.status, "answer");
  assert.equal(activeTurn.finalResponse?.answer, "Reasoning stage answer.");
  assert.deepEqual(
    activeTurn.telemetry.map((item) => item.stage),
    ["local", "reasoning"],
  );
  assert.deepEqual(events, [
    {
      stage: "local",
      decision: "escalate",
      reason: "needs_reasoning",
    },
    {
      stage: "reasoning",
      decision: "answer",
      reason: "resolved",
    },
  ]);
  const response = activeTurn.packet.response as Record<string, unknown>;
  const telemetry = response.telemetry as Record<string, unknown>;
  assert.equal(telemetry.answering_stage, "reasoning");
});

test("forces a final answer retry at the terminal stage", async (t) => {
  const priorApiKey = process.env.TOGETHER_API_KEY;
  process.env.TOGETHER_API_KEY = "test-key";
  t.after(() => {
    if (priorApiKey === undefined) {
      delete process.env.TOGETHER_API_KEY;
    } else {
      process.env.TOGETHER_API_KEY = priorApiKey;
    }
  });

  const routerConfig = config([
    stage({
      id: "thinking",
      provider: "together",
      model: "mock-thinking",
      promptProfile: "thinking",
      baseUrl: "http://thinking-stage.test/v1/chat/completions",
      apiKeyEnv: "TOGETHER_API_KEY",
    }),
  ]);
  const activeTurn = turn("Produce the exact answer.", routerConfig);
  const events: Array<{ stage: string; decision: string; reason: string }> = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let callCount = 0;
  globalThis.fetch = async (_input, init) => {
    callCount += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    if (callCount === 1) {
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: "escalate",
                reason: "still_thinking",
                status_message: "I need more depth.",
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 10,
        },
      });
    }
    assert.match(String(body.messages?.[0]?.content ?? ""), /Forced-answer mode is active\./);
    return jsonResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              decision: "answer",
              reason: "forced_resolution",
              status_message: "Returning the best final answer.",
              answer: "Best effort terminal answer.",
            }),
          },
        },
      ],
      usage: {
        prompt_tokens: 31,
        completion_tokens: 11,
      },
    });
  };

  await executeProviderRouteTurn({
    turn: activeTurn,
    emitStageTelemetry: recorder(events),
  });

  assert.equal(callCount, 2);
  assert.equal(activeTurn.finalResponse?.status, "answer");
  assert.equal(activeTurn.finalResponse?.answer, "Best effort terminal answer.");
  assert.deepEqual(events, [
    {
      stage: "thinking",
      decision: "escalate",
      reason: "still_thinking",
    },
    {
      stage: "thinking",
      decision: "answer",
      reason: "forced_resolution",
    },
  ]);
  const ledger = activeTurn.packet.ledger as Array<Record<string, unknown>>;
  assert.ok(ledger.some((entry) => entry.kind === "semantic_stage_policy" && entry.reason === "force_answer_retry"));
});
