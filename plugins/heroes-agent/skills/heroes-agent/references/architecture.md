# Architecture and invariants

The agent interprets deposited documents, derives a legal move from a railway, and drives deterministic TypeScript scripts. Heroes remains the system of record. The peer workspace holds identity/configuration, intake channels, processed deposits, local rate inputs, and downloaded attachments.

One peer workspace must never contain credentials for multiple tenants. `self/.env` deliberately wins over root `.env` and inherited shell values. Do not centralize credentials across peers.

The runtime uses Node's filesystem APIs and HTTPS `fetch`; no MCP server is needed for local Codex, Claude Code, or Cursor agents. Full ChatGPT web parity would require a hosted MCP service, durable storage/intake redesign, and user-scoped authentication such as OAuth. That is a separate public API and is not implemented here.

Watcher correctness depends on comparing both strategy steps and attachment IDs. Heroes step transitions and attachment uploads are separate API operations, so a step-only watcher can miss a later document.
