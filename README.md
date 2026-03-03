# remram-agents

OpenClaw-native agent and skill ecosystem for Remram.

This repository contains all Remram agent definitions and reusable skills implemented against the OpenClaw specification. Agents and skills are modular and can be selectively installed by the runtime layer.

Gateway packages and registers agents. This repository defines their behavior.

---

## Purpose

`remram-agents` is the behavioral layer of the Remram system.

It contains:

- Agent definitions
- Prompt schemas
- Tool bindings
- Agent-level escalation logic
- Reusable skills
- Shared schemas and utilities

Agents and skills are designed to be composable and independently installable.

---

## Repository Structure

remram-agents/
  agents/
  skills/
  shared/

---

## agents/

Each directory inside `agents/` defines a standalone agent.

Example structure:

agents/
  hydrate/
    agent.yaml
    prompt.md
    tools.yaml
    README.md

An agent folder typically contains:

- `agent.yaml` — OpenClaw agent definition
- `prompt.md` — Core prompt and system framing
- `tools.yaml` — Agent-specific tool bindings
- `README.md` — Agent documentation

Agents represent product surfaces within Remram.

---

## skills/

Reusable behavior modules attachable to one or more agents.

Example structure:

skills/
  reprompt/
    skill.yaml
    logic.ts
    README.md

Skills may:

- Modify prompts
- Enhance escalation behavior
- Add structured memory interaction
- Improve intent inference

Skills are not standalone agents.

---

## shared/

Shared components used across multiple agents and skills.

May include:

- JSON schemas
- Prompt fragments
- Validation utilities
- Common helper logic

---

## Packaging Model

Agents and skills are modular.

The runtime layer (`remram-gateway`) selects and registers which agents are active via its `.openclaw/` configuration.

This repository defines behavior.
Gateway defines availability.

---

## System Context

- `remram` → System definition and documentation
- `remram-gateway` → Execution environment
- `remram-agents` → Agent and skill definitions (this repo)
- `remram-cortex` → Knowledge authority
- `remram-app` → Presentation layer

This repository expands as the Remram ecosystem grows.

