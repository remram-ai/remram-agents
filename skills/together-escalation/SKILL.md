---
name: together-escalation
description: Keep chat local on Ollama while Moltbox uses Together fallback chains for chat, reasoning, and coding.
user-invocable: false
disable-model-invocation: true
metadata: {"openclaw":{"homepage":"https://github.com/RemRam/remram/tree/main/features/together-escalation%20%5Bskill%5D"}}
---

# Together Escalation

This skill documents the Together AI escalation policy already configured in the Moltbox OpenClaw runtime baseline.

## Runtime Policy

- Default chat starts on `ollama/qwen3:8b`.
- Chat falls back to `together/meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` when OpenClaw triggers model failover.
- Reasoning uses `together/moonshotai/Kimi-K2.5` first and falls back to `together/Qwen/Qwen3.5-397B-A17B`.
- Coding uses `together/Qwen/Qwen3-Coder-Next-FP8` first and falls back to `together/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8`.

## Operational Notes

- This skill does not add custom routing logic or a new provider alias.
- The runtime must expose `TOGETHER_API_KEY` to the OpenClaw process.
- The runtime model catalog must include every model in these chains.
- Install this skill as a managed skill or workspace skill. The runtime baseline carries the actual model policy.
