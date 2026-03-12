---
name: semantic-router
description: Local-first staged answer-or-escalate routing for OpenClaw chats, with per-stage telemetry, guardrails, and workflow handoff decisions.
user-invocable: false
metadata: {"openclaw":{"homepage":"https://github.com/RemRam/remram-skills/tree/main/skills/semantic-router"}}
---

# Semantic Router

This package installs a plugin-backed OpenClaw skill that intercepts normal chat turns and routes them through a configured stage ladder.

The runtime behavior is automatic once the plugin is enabled. The skill exists so operators and agents can inspect the installed router package and configuration from the normal OpenClaw skill surface.

## What It Does

- Runs a local-first semantic ladder.
- Keeps the stage contract uniform: `answer`, `escalate`, or `spawn_agent`.
- Enforces configured guardrails around escalation depth, budget, timeout, and workflow dispatch.
- Emits per-stage telemetry, packet ledger entries, debug artifacts, and structured gateway logs.

## Package Layout

- Router code: `{baseDir}/router/`
- Bundled default router config: `{baseDir}/router/default-config.json`
- Example OpenClaw config snippet: `{baseDir}/example-config.json`
- Package documentation: `{baseDir}/README.md`

## Install

Use the normal OpenClaw plugin workflow against the package root:

```bash
openclaw plugins install -l {baseDir}
```

Then allow the plugin explicitly, enable prompt mutation, and add the internal provider alias shown in `{baseDir}/example-config.json`.

## Runtime Configuration

The plugin reads its ladder configuration from:

- `plugins.entries.semantic-router.config.routerConfigPath`, if provided
- otherwise `{baseDir}/router/default-config.json`

The router config may be JSON or simple YAML and defines:

- `requesterDefaults`
- `guardrails`
- `stages`

Each stage may set:

- `id`
- `provider`
- `model` or `modelEnv`
- `fallbackModel`
- `promptProfile`
- `allowedNext`
- `allowSpawnAgent`
- `baseUrl`
- `baseUrlEnv`
- `apiKeyEnv`

## Operational Notes

- The plugin registers the internal provider route `semantic-router/router`.
- The OpenClaw config must define a matching `models.providers.semantic-router` entry that points at `http://127.0.0.1:<gateway-port>/plugins/semantic-router/router/v1`.
- Replace `<gateway-port>` with the real gateway port for the running profile. The default local port is `18789`; `openclaw --dev` uses `19001`.
- `responseFooter: "concise"` preserves the old visible trace footer. `off` hides it.
- Debug artifacts default to `~/.openclaw/semantic-router-debug` unless overridden.

## Telemetry

Per stage, the router records:

- stage
- provider
- model
- decision
- reason
- duration
- tokens in/out

It also emits:

- packet ledger entries
- `model.usage` diagnostic events
- `semantic_router.stage` log lines
- `semantic_router.turn` log lines
