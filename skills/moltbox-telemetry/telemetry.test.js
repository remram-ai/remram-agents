import test from "node:test";
import assert from "node:assert/strict";
import {
  appendTelemetryFooterToAssistantMessage,
  appendTelemetryFooterToAssistantTexts,
  buildNormalizedTelemetryFromDiagnosticEvent,
  buildNormalizedTelemetryFromLlmOutput,
  formatTelemetryFooter,
} from "./lib/telemetry.js";

test("diagnostic normalization prefers last-call usage and derives context percent", () => {
  const telemetry = buildNormalizedTelemetryFromDiagnosticEvent({
    type: "model.usage",
    provider: "ollama",
    model: "ollama/qwen3:8b",
    usage: {
      input: 2_000,
      output: 300,
      total: 2_300,
    },
    lastCallUsage: {
      input: 1_432,
      output: 188,
      total: 1_620,
    },
    context: {
      used: 1_620,
      limit: 32_768,
    },
    durationMs: 842,
  });

  assert.deepEqual(telemetry, {
    model: "ollama/qwen3:8b",
    provider: "ollama",
    input_tokens: 1_432,
    output_tokens: 188,
    total_tokens: 1_620,
    context_pct: 4.9,
    provider_latency_ms: 842,
  });
});

test("llm output normalization resolves context window from config fallback", () => {
  const telemetry = buildNormalizedTelemetryFromLlmOutput({
    event: {
      provider: "ollama",
      model: "ollama/qwen3:8b",
      usage: {
        input: 900,
        output: 100,
        total: 1_000,
      },
      lastAssistant: {
        usage: {
          input: 800,
          output: 100,
          total: 900,
        },
      },
    },
    config: {
      agents: {
        defaults: {
          contextTokens: 8_000,
        },
      },
    },
    latencyMs: 731,
  });

  assert.deepEqual(telemetry, {
    model: "ollama/qwen3:8b",
    provider: "ollama",
    input_tokens: 800,
    output_tokens: 100,
    total_tokens: 900,
    context_pct: 11.3,
    provider_latency_ms: 731,
  });
});

test("assistant text footer appends to the last reply chunk", () => {
  const footer = formatTelemetryFooter({
    model: "test-model",
    provider: "test-provider",
  });
  const assistantTexts = ["first", "second"];

  const appended = appendTelemetryFooterToAssistantTexts(assistantTexts, footer);

  assert.equal(appended, true);
  assert.deepEqual(assistantTexts, ["first", `second\n${footer}`]);
});

test("assistant message footer appends to the last text block", () => {
  const footer = formatTelemetryFooter({
    model: "test-model",
    provider: "test-provider",
  });
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "..." },
      { type: "text", text: "hello" },
    ],
  };

  const appended = appendTelemetryFooterToAssistantMessage(message, footer);

  assert.equal(appended, true);
  assert.deepEqual(message.content, [
    { type: "thinking", thinking: "..." },
    { type: "text", text: `hello\n${footer}` },
  ]);
});
