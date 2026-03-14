# remram-skills

`remram-skills` owns the portable skill and plugin packages used by the Moltbox appliance.

This repository is not the control plane and it is not the runtime baseline.
It provides the package source material that `moltbox-gateway` stages into environments and that `moltbox-runtime` may reference from baseline config.

## Current Scope

The active package roots live under `skills/`.

Current examples in this checkout:

- `skills/together-escalation/`: managed skill content for the Together fallback feature
- `skills/semantic-router/`: plugin-backed skill package retained as implementation material, even though it is no longer part of the active Moltbox runtime baseline

## Ownership Boundary

`remram-skills` owns:

- `SKILL.md` package content
- plugin package source such as `openclaw.plugin.json`, `index.ts`, and `package.json`
- skill-local helper files, manifests, and bundled resources

`remram-skills` does not own:

- appliance CLI taxonomy
- service deployment definitions
- baseline runtime config
- live runtime replay state on the appliance

Those concerns belong to:

- `remram` for architecture and platform docs
- `moltbox-gateway` for CLI, orchestration, and replay state
- `moltbox-runtime` for baseline runtime configuration
- `moltbox-services` for service definitions

## Package Model

OpenClaw-visible skills remain directories containing `SKILL.md`.

Some packages are pure skill content.
Some are plugin-backed and also ship an `openclaw.plugin.json` manifest plus code.

Gateway-managed skill deployment currently stages skill directories from this repository into runtime state under `~/.openclaw/skills`.
Native OpenClaw plugin lifecycle still applies where a package also ships plugin code.

## Related Repositories

- `remram`: architecture, platform registry docs, feature docs
- `moltbox-gateway`: control plane, `moltbox` CLI, deployment and replay orchestration
- `moltbox-runtime`: baseline runtime config consumed during deploy
- `moltbox-services`: service definitions for `gateway`, `caddy`, `ollama`, `opensearch`, and the runtime containers
