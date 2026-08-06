# Heroes Agent

Heroes Agent turns a local agent into one tenant-scoped logistics peer for Logic Heroes. It triages deposited documents, drives legal HANDSHAKE and solicited one-to-one RFQ transitions, quotes from a local CSV rate book, downloads service attachments, and watches for counterparty changes. The original demo remains outside this plugin unchanged.

The plugin targets local Codex, Claude Code, and Cursor agents. It does not provide equivalent browser-based ChatGPT operation: that would require a hosted MCP server, OAuth/user tenancy, durable hosting, and a replacement for local filesystem intake.

## Quick start (agents)

Right after installing this plugin, before any Heroes operation:

1. Ask the human for **tenant key** and **display name** (never invent them).
2. If tool dependencies are missing, run `node <plugin-root>/scripts/setup-tools.mjs`.
3. Run `node <plugin-root>/scripts/init-peer.mjs run/<tenant-key> --tenant-key <key> --display-name <name>`.
4. Open `run/<tenant-key>/self/.env` (hosted `API_URL` is already set; `API_KEY` is blank).
5. Stop and wait until the human sets `API_KEY`. Never print the key.
6. Only then triage intake, drive railways, or call authenticated tools.

If the peer already exists with a blank key, open `self/.env` and wait. If the key is set, skip to normal operation.

## Quick start (humans)

1. Install the plugin on your agent host (commands below).
2. Tell the agent your **tenant key** and **display name**.
3. When it opens `run/<your-tenant>/self/.env`, paste your Logic Heroes API key into `API_KEY`.
4. Leave `API_URL` as `https://api.logicheroes.network/api` unless you run Heroes locally (`http://localhost:3401/api`).
5. Do not commit `self/.env`. Ask the agent to continue once the key is saved.

## Repository structure

```text
plugins/heroes-agent/
  .codex-plugin/plugin.json       Codex adapter
  .claude-plugin/plugin.json      Claude Code adapter
  .cursor-plugin/plugin.json      Cursor adapter
  skills/heroes-agent/
    SKILL.md                      shared portable workflow
    references/                  railway, domain, rate, portability details
    scripts/heroes-tools/        shared TypeScript runtime and offline tests
    assets/peer-template/        secret-free peer workspace skeleton
  scripts/
    init-peer.mjs                cross-platform workspace initializer (writes blank-key env stub)
    run-tool.mjs                 tool launcher that preserves peer working directory
    setup-tools.mjs              locked dependency setup and optional checks
    validate-portability.mjs     repository safety/static checks
  assets/                        reserved for plugin-wide media
  .env.example                   documented variable names only
```

The platform manifests are metadata adapters. They do not duplicate skills, scripts, or an MCP implementation.

## Install

### Codex / local ChatGPT coding agent

Add this repository root as a marketplace with `codex plugin marketplace add <repository-root>`, then explicitly install the plugin with `codex plugin add heroes-agent@heroes-agent`. Start a new task so the installed skill is rediscovered. Codex can run the local skill and scripts; browser-based ChatGPT cannot run this local workflow without the separate hosted design described above.

### Claude Code

Add the repository marketplace with `claude plugin marketplace add <repository-root>`, then run `claude plugin install heroes-agent@heroes-agent`. For direct local development, run `claude --plugin-dir plugins/heroes-agent` from the repository root. The explicit skill name is `/heroes-agent:heroes-agent`.

### Cursor

For a local CLI session, run `cursor-agent --plugin-dir plugins/heroes-agent` from the repository root. For local IDE installation, copy the plugin to `~/.cursor/plugins/local/heroes-agent` on macOS/Linux or `%USERPROFILE%\.cursor\plugins\local\heroes-agent` on Windows, then run **Developer: Reload Window** (or restart Cursor) and verify discovery in Customize or chat. A symlink may be used as a development convenience where the operating system and permissions support it, but the plugin does not depend on symlinks. Once a public repository is submitted and accepted by Cursor Marketplace, users can install it with `/add-plugin heroes-agent`.

No installation command above stores a Heroes credential in a manifest or marketplace file.

## Peer initialization and authentication

Node.js 18 or newer is required and enforced by the setup helper; Node.js 22 is recommended. Install the shared development/runtime dependencies once:

```text
node plugins/heroes-agent/scripts/setup-tools.mjs
```

The helper runs the locked `npm ci` with the shared tools directory as the actual child-process working directory. This avoids npm-version-dependent `--prefix` behavior and works with `npm.cmd` on Windows.

Create an isolated peer workspace (agents should use `run/<tenant-key>/`):

```text
node plugins/heroes-agent/scripts/init-peer.mjs run/acme-corp --tenant-key acme-corp --display-name "Acme Corp"
```

`init-peer` creates an ignored `self/.env` stub automatically:

- `API_URL`: set to `https://api.logicheroes.network/api` (change to `http://localhost:3401/api` only for local Heroes);
- `API_KEY`: left blank for the human to fill.

All Heroes JSON and multipart calls use `x-api-key`. Local rate ingestion and lookup do not require authentication. One workspace must contain only one tenant credential.

- **Codex:** open and edit `self/.env` inside the peer workspace; allow network or mutation commands when prompted. Do not put values in Codex marketplace metadata.
- **Claude Code:** edit the same ignored file. This plugin does not declare `userConfig`, because the runtime intentionally binds identity to the peer workspace. Claude's background-task behavior may help watchers but is not an authentication store.
- **Cursor:** edit the same ignored file (agent should open it after init). This plugin does not declare Cursor `variables`, because dashboard values would not automatically populate the workspace-scoped runtime. Allow local shell/network actions according to workspace policy.

The runtime reads `self/.env` first and root `.env` second; file values override inherited shell values to prevent cross-peer credential leakage. Never commit either filled file.

## Use

Representative prompts:

- “Set up a Heroes peer workspace for tenant `globex`; show me which local values I still need to provide.”
- “A booking PDF landed in `counterparties/acme/intake/`. Triage it and start the legal HANDSHAKE move.”
- “Inspect this incoming RFQ, find the applicable filed rate, prepare the quote, and watch for a reply.”
- “Check service `…`, download new attachments, and tell me whether a business decision is due.”
- “Ingest the CSV files in my rate-book inbox with a dry run first.”

The agent confirms identity at session start, derives maker/taker per move, consults the railway before mutations, and asks the human only for genuine commitments. Payload staging accepts exactly one non-hidden file.

## Local development

```text
node plugins/heroes-agent/scripts/setup-tools.mjs --check
node plugins/heroes-agent/scripts/init-peer.mjs temporary-peer --tenant-key smoke-peer --display-name "Smoke Peer" --dry-run
node plugins/heroes-agent/scripts/validate-portability.mjs
```

`--check` runs locked installation, TypeScript typechecking, offline runtime unit tests, and cross-platform helper integration checks from the correct working directories. The helper checks create a real nested peer destination under the operating system's temporary directory, confirm the `self/.env` stub is created with a blank `API_KEY`, verify overwrite refusal, and clean up afterward.

From a peer workspace, use `node <plugin-root>/scripts/run-tool.mjs <script-name> <arguments>` to run a bundled TypeScript tool. The launcher keeps the peer workspace as the current directory, so `self/.env`, intake, and rate-book defaults resolve correctly. Network scripts require local credentials. `ingest-rates.ts --dry-run` and `find-rate.ts` can be tested offline.

## Portability limitations

- Durable watcher wake/resume is host-specific. Foreground execution is portable. Exit `0` means a step or attachment changed; exit `3` means timeout. A host restart may lose the wait.
- Shell/network/file-write approvals differ by platform; this plugin does not bypass them.
- Skills are shared, but invocation names and discovery UI differ. No hooks, custom UI, or subagents are required.
- Two counterparties need separate workspaces and credentials. One agent must never impersonate both peers.
- There is no MCP server. Full ChatGPT web parity requires a separately designed hosted MCP/OAuth/intake system.
- Cursor currently provides no general official plugin validator command. CLI plugin-directory discovery and manual IDE reload remain necessary platform tests.

## Validation

Run:

```text
python3 <plugin-creator-skill>/scripts/validate_plugin.py plugins/heroes-agent
claude plugin validate plugins/heroes-agent --strict
claude plugin validate . --strict
node plugins/heroes-agent/scripts/setup-tools.mjs --check
node plugins/heroes-agent/scripts/validate-portability.mjs
cursor-agent --plugin-dir plugins/heroes-agent
```

The portability validator checks JSON/path presence, normalized manifest names, skill frontmatter, filled `.env` files, private-key headers, JWT-like values, common GitHub/AWS/API token shapes, machine-local paths, `.DS_Store`, and symlinks. It intentionally allows documented variable names such as `API_KEY` and scans only declared plugin/marketplace outputs, never the ignored source-demo `.env`. If no Git repository exists, it explicitly reports that a tracked-file scan is unavailable instead of claiming tracked-file coverage. Cursor's plugin-directory command is a discovery smoke test, not an official schema validator. Heroes authentication and mutation tests require a disposable tenant and explicit credentials and are not run by repository validation.

## Public-release checklist

- [ ] Choose and add a license. No existing license was found, so this is a release blocker.
- [ ] Add real repository, homepage, support, privacy, and terms URLs only after they exist.
- [ ] Run all offline validation commands and manual plugin discovery on all three platforms.
- [ ] Test HANDSHAKE and RFQ against disposable Heroes tenants without exposing credentials.
- [ ] Confirm the archive contains no `.env`, secrets, signed download URLs, `.DS_Store`, broken symlinks, or machine-local paths.
- [ ] Repeat the secret scan against the actual Git tracked-file set once the plugin is placed in a Git repository.
- [ ] Verify watcher step-change and attachment-only change behavior against the service API.
- [ ] Confirm marketplace ownership and public submission requirements for each platform.
- [ ] Review sample rate data before publication; it is demonstrative business data, not a live rate offer.

No license field or file is included because none existed to preserve.
