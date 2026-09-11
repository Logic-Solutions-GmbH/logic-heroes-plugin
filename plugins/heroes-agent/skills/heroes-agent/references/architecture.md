# Architecture and invariants

The agent interprets deposited documents, derives a legal move from a railway, and drives deterministic TypeScript scripts. Heroes remains the system of record. The peer workspace holds identity/configuration, intake channels, processed deposits, local rate inputs, and downloaded attachments.

The rate-contract module is the interface for local pricing. The Heroes catalog adapter supplies controlled vocabulary. CSV import and export are adapters. Deterministic discovery returns one approved current rule or an explicit unsafe state. It never ranks applicable rules by price.

CLI orchestration owns rate-inbox archival after successful persistence. `RateStore.ingestRates` persists rows only. Storage adapters never move input files, and callers never branch on adapter type.

One peer workspace binds one Heroes tenant to one explicit Supabase project. The ignored local binding records both identities. The bootstrap command verifies the selected project before any migration. Supabase stores private operational state; it never replaces authoritative Heroes network state.

One confirmed rate profile maps the stable rate contract to the bound Supabase project. Adapters resolve resources and fields through this profile. They do not infer a physical schema. A proposal cannot support operations.

One peer workspace must never contain credentials for multiple tenants. `self/.env` deliberately wins over root `.env` and inherited shell values. Do not centralize credentials across peers.

The runtime uses Node's filesystem APIs and HTTPS `fetch`; no MCP server is needed for local Codex, Claude Code, or Cursor agents. Full ChatGPT web parity would require a hosted MCP service, durable storage/intake redesign, and user-scoped authentication such as OAuth. That is a separate public API and is not implemented here.

Watcher correctness depends on comparing both strategy steps and attachment IDs. Heroes step transitions and attachment uploads are separate API operations, so a step-only watcher can miss a later document.
