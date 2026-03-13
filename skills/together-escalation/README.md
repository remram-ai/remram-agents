# Together Escalation

This skill folder documents the Moltbox Together AI escalation baseline for OpenClaw runtimes.

The runtime behavior is implemented in `moltbox-runtime` and `moltbox-services`:

- chat stays local on `ollama/qwen3:8b` with Together Maverick as fallback
- reasoning uses Kimi K2.5 with Qwen 3.5 397B as fallback
- coding uses Qwen Coder Next with Qwen Coder 480B as fallback

The skill itself is intentionally lightweight. It exists so the feature can be distributed through the current OpenClaw skills system without adding custom plugin code.
