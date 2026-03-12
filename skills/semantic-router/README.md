# Semantic Router

This package implements the Remram Semantic Router as a standard OpenClaw plugin-backed skill.

## Structure

- `SKILL.md`: installed OpenClaw skill entry
- `openclaw.plugin.json`: plugin manifest
- `package.json`: OpenClaw extension package metadata
- `index.ts`: plugin registration entrypoint
- `router/`: router logic and bundled default config
- `example-config.json`: example `openclaw.json` snippet

## Install

Link the package into OpenClaw during development:

```bash
openclaw plugins install -l /absolute/path/to/remram-skills/skills/semantic-router
```

For a copied install:

```bash
openclaw plugins install /absolute/path/to/remram-skills/skills/semantic-router
```

Verify:

```bash
openclaw plugins list
openclaw plugins info semantic-router
openclaw skills list --eligible
```

Trust the plugin explicitly:

```bash
openclaw config set plugins.allow '["semantic-router"]' --strict-json
```

## Required OpenClaw Configuration

Merge the snippet from `example-config.json` into `~/.openclaw/openclaw.json`.

Two pieces matter:

1. Allow and enable the plugin with prompt injection allowed.
2. Add the `semantic-router` internal provider alias that targets the plugin route on your active gateway port.

The router will load its bundled default ladder if `routerConfigPath` is omitted.

The provider `baseUrl` must match your actual gateway port:

- `18789` for the default local gateway
- `19001` for `openclaw --dev` runs
- another port if you start the gateway explicitly with `--port`

## Bundled Default Ladder

The bundled `router/default-config.json` keeps the old behavior:

- local `ollama` stage
- remote `together` reasoning stage
- remote `together` deep-thinking terminal stage

You can override the ladder entirely by pointing `routerConfigPath` at a JSON or YAML file.

## Telemetry

The router preserves the old diagnostic surfaces:

- per-turn debug artifacts
- packet ledger stage entries
- `model.usage` diagnostic events
- `semantic_router.stage` structured log records
- `semantic_router.turn` structured log records

## Notes

- The visible footer is optional and controlled by `responseFooter`.
- The package uses only official OpenClaw plugin/skill loading behavior.
- No router logic lives in the gateway repository.

## Regression Checks

Core router regression tests can be run with `tsx`:

```bash
npx tsx --test router/index.test.ts
```
