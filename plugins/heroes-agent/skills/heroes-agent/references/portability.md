# Platform portability

The skill, Node/TypeScript runtime, railway references, and peer template are shared across local Codex, Claude Code, and Cursor agents.

- Instruction discovery and explicit invocation differ. Do not depend on host-specific skill variables or frontmatter.
- Claude Code may support background tasks that resume a session. Codex and Cursor hosts may not. Foreground watching is the portable baseline; no manifest promises durable wakeup.
- Shell, filesystem, network, and mutation approvals differ. The plugin does not bypass them.
- Symlinks and POSIX-only environment syntax are not required. The initializer uses Node path and filesystem APIs.
- Credential configuration UX differs, but all runtime scripts read the same ignored `self/.env` or `.env` names. `init-peer` creates a blank-key `self/.env` stub with the hosted API URL; agents open that file for the human. Cursor manifest variables are not used because they would not populate this local runtime automatically.
- Hooks, UI, subagents, and MCP are not implemented. Do not simulate both counterparties with a subagent; use separate peer workspaces and credentials.
- Browser-based ChatGPT cannot operate this local-filesystem workflow from these assets alone. Full parity requires a hosted MCP/OAuth and intake design.
