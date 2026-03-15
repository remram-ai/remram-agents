# Moltbox Telemetry

`moltbox-telemetry` is the first Moltbox runtime plugin package for OpenClaw.

It observes OpenClaw `model.usage` diagnostics, normalizes the Moltbox telemetry
contract, and exposes the same field names in two places:

- response-side telemetry footer lines attached to reply text
- diagnostics-side JSON log records with `type: "moltbox.telemetry"`

Normalized fields:

- `model`
- `provider`
- `input_tokens`
- `output_tokens`
- `total_tokens`
- `context_pct`
- `provider_latency_ms`

## Package Layout

```text
skills/moltbox-telemetry/
  index.js
  lib/telemetry.js
  openclaw.plugin.json
  package.json
  README.md
  telemetry.test.js
```

## Config Surface

The plugin uses the standard OpenClaw plugin entry and does not require plugin
specific config.

```yaml
plugins:
  enabled: true
  entries:
    moltbox-telemetry:
      enabled: true
```

Runtime assumptions during validation:

- `diagnostics.enabled: true`
- `/thinking auto`
- `/usage full`

## Install

From the package directory:

```text
openclaw plugins install .
openclaw plugins info moltbox-telemetry
```

From the `remram-skills` repo root:

```text
openclaw plugins install ./skills/moltbox-telemetry
openclaw plugins info moltbox-telemetry
```

## Validation

Current public OpenClaw CLI validation path on `2026.3.13`:

```text
openclaw agent --local --agent main --message "hello" --json
```

If you are validating against an older/internal build that still exposes
`openclaw chat`, use the equivalent one-shot chat path there instead.

Expected response footer shape:

```text
Telemetry: {"model":"...","provider":"...","input_tokens":0,"output_tokens":0,"total_tokens":0,"context_pct":0,"provider_latency_ms":0}
```

Expected diagnostics log shape:

```json
{
  "type": "moltbox.telemetry",
  "session_id": "session-...",
  "session_key": "session-...",
  "telemetry": {
    "model": "...",
    "provider": "...",
    "input_tokens": 0,
    "output_tokens": 0,
    "total_tokens": 0,
    "context_pct": 0,
    "provider_latency_ms": 0
  }
}
```

## Test

```text
npm test
```
