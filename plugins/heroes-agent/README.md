# Heroes Agent

Heroes Agent turns a local agent into one tenant-scoped logistics peer for Logic Heroes. It triages deposited documents, drives legal HANDSHAKE and solicited one-to-one RFQ transitions, quotes from a local rate catalog, downloads service attachments, and watches for counterparty changes. The original demo remains outside this plugin unchanged.

The plugin targets local Codex, Claude Code, and Cursor agents. It does not provide equivalent browser-based ChatGPT operation: that would require a hosted MCP server, OAuth/user tenancy, durable hosting, and a replacement for local filesystem intake.

## Quick start (agents)

Before any Heroes operation, collect these inputs:

- Node.js 18 or newer and the CLI for the selected host;
- the repository root and the plugin root at `plugins/heroes-agent`;
- a peer parent directory where the operator can create `run/<tenant-key>`;
- the human-provided **tenant key** and **display name** (never invent them);
- npm registry access, or a complete local npm cache, for dependency setup.

Then:

1. For Codex or Claude Code, add the repository catalog and install the plugin with the command in [Install](#install). For Cursor, use the documented Dashboard import or local loader.
2. Record the plugin root and the peer workspace path. `run/<tenant-key>` is relative to the current directory, not the plugin directory.
3. Run `node <plugin-root>/scripts/setup-tools.mjs` if tool dependencies are missing.
4. From the chosen peer parent directory, run `node <plugin-root>/scripts/init-peer.mjs run/<tenant-key> --tenant-key <key> --display-name <name>`.
5. Open `run/<tenant-key>/self/.env`. The hosted `API_URL` is set, and `API_KEY` is blank.
6. Stop and wait until the human sets `API_KEY`. Never print the key.
7. Change directory to `run/<tenant-key>` before any `run-tool.mjs` command.
8. Only then triage intake, drive railways, or call authenticated tools.

If the peer already exists, do not rerun initialization or overwrite it. Follow [Recovery](#recovery).

## Quick start (humans)

1. Load the plugin on your agent host with a current command below.
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
  assets/                        public plugin icon and logo
  .env.example                   documented variable names only
```

The platform manifests are metadata adapters. They do not duplicate skills, scripts, or an MCP implementation.

## Install

The repository has one catalog for each host. Each catalog resolves the same `plugins/heroes-agent` root. A persistent installation can require a new host session before discovery.

### Codex / local ChatGPT coding agent

From the repository root, load the repository catalog and install the plugin:

```text
codex plugin marketplace add . --json
codex plugin add heroes-agent@logic-heroes --json
codex plugin list --json
```

Record `installedPath` from the `codex plugin add heroes-agent@logic-heroes --json` result. It is the plugin root for setup, initialization, and tool commands. The list result must show `heroes-agent@logic-heroes` as installed and enabled.

Start a new Codex session after installation. First, prove skill discovery without file or network work:

```text
Use $heroes-agent. Read its installed instructions. State the two human values required before peer initialization. Do not create files or call a network service.
```

The response must ask for the tenant key and display name as fenced JSON. The next prompt uses `smoke-peer` and `Smoke Peer` as examples. Replace both JSON values before you send it:

````text
Use $heroes-agent. Create one peer workspace from this identity:
```json
{
  "tenantKey": "smoke-peer",
  "displayName": "Smoke Peer"
}
```
Copy both JSON string values character-for-character. After initialization, compare both values with self/identity.md. Do not use a network service. Stop when a Heroes API key is required.
````

The agent must preserve both JSON values exactly, create the peer with the installed helper, compare both stored values, and stop at the blank `API_KEY`. The install JSON proves catalog state. The new-session response and peer files prove skill discovery and use. One result does not replace the other.

Use `codex plugin marketplace list --json` and `codex plugin list --json` to inspect the loaded catalog and plugin. Browser-based ChatGPT cannot run this local workflow without the separate hosted design described above.

### Claude Code

From the repository root, validate both the catalog and plugin. Then add the catalog and install the plugin:

```text
claude plugin validate . --strict
claude plugin validate plugins/heroes-agent --strict
claude plugin marketplace add ./
claude plugin install heroes-agent@logic-heroes
claude plugin marketplace list
claude plugin list --json
claude plugin details heroes-agent@logic-heroes
```

The marketplace list must show `logic-heroes`. The plugin list must show
`heroes-agent@logic-heroes` version `1.0.0` as installed and enabled. Plugin details must show
one skill and zero agents, hooks, MCP servers, and LSP servers.

Start a new session and invoke `/heroes-agent:heroes-agent` to verify discovery. A disposable
`HOME` and `CLAUDE_CONFIG_DIR` are suitable for marketplace and installation checks. On macOS,
an existing Claude subscription login can remain bound to the normal configuration through the
Keychain and therefore be unavailable to that isolated configuration. For a live discovery smoke
test in that case, use the normal authenticated Claude session with an explicit disposable
`--plugin-dir`; this keeps the tested plugin source disposable without changing the normal Claude
plugin installation.

### Cursor

Cursor teams can import the public repository through **Dashboard > Plugins > Import from Repo**. Cursor reads `.cursor-plugin/marketplace.json` and resolves `plugins/heroes-agent`.

For the documented direct local loader in the IDE, copy or link `plugins/heroes-agent` to `~/.cursor/plugins/local/heroes-agent`. Restart Cursor or run **Developer: Reload Window**, then verify the skill.

For the verified Agent CLI smoke path, load the plugin directly from a fresh archive source:

```sh
cursor-agent -p --output-format text --model composer-2.5 --force --trust \
  --workspace <disposable-workspace> \
  --plugin-dir <disposable-source>/plugins/heroes-agent \
  "<prompt>"
```

Cursor provides no general plugin validator and no local CLI install or list flow comparable to Codex or Claude Code. `cursor-agent plugin marketplace list` is read-only account visibility only. A direct `--plugin-dir` load proves manifest and skill acceptance; it does not prove Dashboard import or account marketplace indexing. See `docs/release-evidence/slice-9-cursor-smoke.md`.

No installation command above stores a Heroes credential in a manifest or marketplace file.

## Peer initialization and authentication

Node.js 18 or newer is required and enforced by the setup helper; Node.js 22 is recommended. Install the shared development/runtime dependencies once:

```text
node plugins/heroes-agent/scripts/setup-tools.mjs
```

The helper always runs locked `npm ci` with the shared tools directory as the child-process working directory. It needs npm registry access unless the npm cache contains every locked package. It writes `node_modules` under the shared tools directory. With `--check`, it installs first, then runs TypeScript typechecking, the full offline package tests, and cross-platform helper checks. It works with `npm.cmd` on Windows.

Choose a peer parent directory, record the plugin root, and create an isolated peer workspace. The destination resolves from the caller's current directory:

```text
node <plugin-root>/scripts/init-peer.mjs run/acme-corp --tenant-key acme-corp --display-name "Acme Corp"
```

`init-peer` creates an ignored `self/.env` stub automatically:

- `API_URL`: set to `https://api.logicheroes.network/api` (change to `http://localhost:3401/api` only for local Heroes);
- `API_KEY`: left blank for the human to fill.

All Heroes JSON and multipart calls use `x-api-key`. Local rate ingestion and lookup do not require authentication. One workspace must contain only one tenant credential.

- **Codex:** open and edit `self/.env` inside the peer workspace; allow network or mutation commands when prompted. Do not put values in Codex marketplace metadata.
- **Claude Code:** edit the same ignored file. This plugin does not declare `userConfig`, because the runtime intentionally binds identity to the peer workspace. Claude's background-task behavior may help watchers but is not an authentication store.
- **Cursor:** edit the same ignored file (agent should open it after init). This plugin does not declare Cursor `variables`, because dashboard values would not automatically populate the workspace-scoped runtime. Allow local shell/network actions according to workspace policy.

At runtime, `self/.env` wins over root `.env`; either file wins over inherited shell values. If neither file exists, inherited `API_URL` and `API_KEY` remain active, and `API_URL` defaults to `http://localhost:3401/api`. The initializer creates hosted `self/.env`. Never commit either filled file.

## Recovery

- If the destination exists, do not rerun initialization. Do not delete or overwrite the peer.
- If `self/.env` is missing, copy `self/.env.example` to `self/.env`, set `API_URL=https://api.logicheroes.network/api`, leave `API_KEY` blank, and wait for the human.
- If `self/identity.md` is missing, or its required tenant key or display name is missing or still a placeholder, stop. Ask the human for those required values before any Heroes action. The three optional fields may remain `<optional>`.
- If dependencies are missing, run `node <plugin-root>/scripts/setup-tools.mjs`. It executes `npm ci` and writes `node_modules`.
- If authentication fails, verify the effective `API_URL` and the tenant-specific `API_KEY`. Never print the key.
- After a host restart, start a new foreground watch. Durable watcher resume is not promised.

## Use

Representative prompts:

- “Set up a Heroes peer workspace for tenant `smoke-peer`; show me which local values I still need to provide.”
- “A booking PDF landed in `counterparties/acme/intake/`. Triage it and start the legal HANDSHAKE move.”
- “Inspect this incoming RFQ, find the applicable filed rate, prepare the quote, and watch for a reply.”
- “Check service `…`, download new attachments, and tell me whether a business decision is due.”
- “Ingest the CSV files in my rate-book inbox with a dry run first.”
- “Hapag sent us this door quote. File it in Heroes as an offer from them to us.”

The agent confirms identity at session start, derives maker/taker per move, consults the railway before mutations, and asks the human only for genuine commitments. Payload staging accepts exactly one non-hidden file.

RFQ initiation prints the new service ID. The requester must hand that ID to the provider through the existing business channel. The provider then runs `service-status.ts <service-id>`. The current Heroes requests endpoint does not enumerate RFQ strategies, so `list-requests.ts` is HANDSHAKE-only. This is a current API limitation, not automatic RFQ discovery.

## Local development

```text
node plugins/heroes-agent/scripts/setup-tools.mjs --check
node plugins/heroes-agent/scripts/init-peer.mjs temporary-peer --tenant-key smoke-peer --display-name "Smoke Peer" --dry-run
```

`--check` runs locked installation, TypeScript typechecking, offline runtime unit tests, and cross-platform helper integration checks from the correct working directories. The helper checks create a real nested peer destination under the operating system's temporary directory, confirm the `self/.env` stub is created with a blank `API_KEY`, verify overwrite refusal, and clean up afterward.

From the peer workspace, use `node <plugin-root>/scripts/run-tool.mjs <script-name> <arguments>` to run a bundled TypeScript tool. The launcher keeps that peer workspace as the current directory, so `self/.env`, intake, and rate-book defaults resolve there. Network scripts require local credentials.

To add one document to an existing event without changing its strategy step, stage exactly one non-hidden file and run:

```text
node <plugin-root>/scripts/run-tool.mjs upload-attachment.ts <event-id> <payload-folder>
```

This command uses the multipart attachment endpoint. It is the public validation seam for an attachment-only watcher change.

If journey creation succeeds but a later shipment step fails, resume on that journey without creating a duplicate:

```text
node <plugin-root>/scripts/run-tool.mjs create-shipment.ts <payload-folder> --target <tenant-key> --journey-id <journey-id>
```

The resume option skips `POST /journeys`. It creates the service and starts HANDSHAKE on the supplied journey. Use it only when service creation did not succeed; it cannot prevent a duplicate service after a later partial failure.

RFQ creation has the same journey-only recovery boundary:

```text
node <plugin-root>/scripts/run-tool.mjs request-quotation.ts <payload-folder> --target <provider-key> --journey-id <journey-id>
```

Use it only when RFQ service creation did not succeed. It skips duplicate journey creation, but it cannot prevent a duplicate service after a later partial failure.

To file a quote a counterparty already sent — a carrier PDF, a spot-rate mail — as a Heroes `OFFER`, describe it once in a JSON spec and preview before writing:

```text
node <plugin-root>/scripts/run-tool.mjs compose-offer.ts <offer-spec.json> --dry-run
node <plugin-root>/scripts/run-tool.mjs compose-offer.ts <offer-spec.json> --attach <payload-folder>
```

`compose-offer.ts` creates one `OFFER` journey, its services with `participantTenantKeys.issuer` / `.recipient`, and one `DIRECT_QUOTE / QUOTED` advance carrying the `offer_charges` payload, then attaches the staged document to the returned event. Location roles and timeframe kinds are read from `GET /catalog/location-roles` and `GET /catalog/timeframe-kinds`; neither list is hard-coded, and neither is scraped from the published spec. It refuses rather than invents: exit `5` when the issuer has no Heroes tenant, exit `6` when Heroes did not persist the offer relationship (releasing its services and then its journey), exit `7` for a journey create whose outcome is unknown — never retried, because a retry mints a second offer. Exit `8` means the quote is recorded and only the document is missing; re-attach with `upload-attachment.ts`. See `skills/heroes-agent/references/offer.md` for the spec shape and the worked example.

For a rate-contract test, first save the current Heroes catalog. Then copy `self/rate-book/sample-rates.csv` to `self/rate-book/inbox/sample-rates.csv`, preview the import, import it, and query the created index:

```text
node <plugin-root>/scripts/run-tool.mjs sync-rate-catalog.ts
node <plugin-root>/scripts/run-tool.mjs ingest-rates.ts --dry-run
node <plugin-root>/scripts/run-tool.mjs ingest-rates.ts --approve-by "<operator name>"
node <plugin-root>/scripts/run-tool.mjs find-rate.ts --service-key fcl_freight_forwarding --origin NLRTM --dest USNYC --asset-type container --asset-subtype 40HC --date 2026-09-01
node <plugin-root>/scripts/run-tool.mjs export-rates.ts
```

`sync-rate-catalog.ts` is read-only and uses the existing peer credential. `ingest-rates.ts --dry-run` still needs an existing inbox. `find-rate.ts` exits `2` until both `heroes-catalog.json` and `rate-catalog.json` exist. It exits `4` for missing facts, ambiguity, or invalid data. It never selects the cheapest result.

## Local data and the system of record

The peer workspace stores local identity, ignored credentials, intake deposits, processed copies, the provider-owned rate catalog, railway copies, and downloaded attachments. CSV is an import and export adapter. Local documents are inputs or downloaded projections. Provider-owned rates can support a quote, but they are pricing evidence rather than shared Heroes state.

Heroes stores the authoritative journey, service, strategy step, event, participant, and attachment state. Legal moves and counterparty state pass through the Heroes railway and API. A local file cannot prove acceptance, rejection, quotation, or the current service step. If local data conflicts with Heroes, the Heroes state controls the next legal move. Local data can be recreated or replaced; the shared legal state must come from Heroes.

## Portability limitations

- Durable watcher wake/resume is host-specific. Foreground execution is portable. Exit `0` means a step or attachment changed; exit `3` means timeout. A host restart may lose the wait.
- Shell/network/file-write approvals differ by platform; this plugin does not bypass them.
- Skills are shared, but invocation names and discovery UI differ. No hooks, custom UI, or subagents are required.
- Two counterparties need separate workspaces and credentials. One agent must never impersonate both peers.
- There is no MCP server. Full ChatGPT web parity requires a separately designed hosted MCP/OAuth/intake system.
- Cursor provides no general plugin validator and no local CLI install or list flow. The verified acceptance path is direct Agent CLI `--plugin-dir` discovery. Dashboard import and IDE local loading remain documented but are not proven by that CLI smoke.

## Clean-checkout validation

Use a disposable clean checkout. Do not reuse installed dependencies. These checks do not need a live Heroes tenant:

```text
python3 <plugin-creator-skill>/scripts/validate_plugin.py plugins/heroes-agent
claude plugin validate . --strict
claude plugin validate plugins/heroes-agent --strict
node plugins/heroes-agent/scripts/validate-portability.mjs
node plugins/heroes-agent/scripts/setup-tools.mjs --check
node plugins/heroes-agent/scripts/init-peer.mjs temporary-peer --tenant-key smoke-peer --display-name "Smoke Peer" --dry-run
```

Required inputs and expected results:

| Check | Required inputs | Expected result |
| --- | --- | --- |
| `init-peer.mjs ... --dry-run` | Node.js 18+, tenant key, display name, destination | Exit `0`; report the resolved destination; write no peer files. |
| `setup-tools.mjs --check` | Node.js 18+, npm, registry access or a complete cache, writable checkout | Exit `0`; install dependencies into `node_modules`; pass typecheck, all offline package tests, and helper checks. |
| `validate_plugin.py` | Python 3 and the external Codex `plugin-creator` skill directory | Exit `0`. Replace `<plugin-creator-skill>` with the directory that contains that skill's `scripts/validate_plugin.py`. |
| `claude plugin validate . --strict` | Installed Claude CLI | Exit `0`; validate the root marketplace without warnings. |
| `claude plugin validate plugins/heroes-agent --strict` | Installed Claude CLI | Exit `0`. |
| `validate-portability.mjs` | Node.js 18+ | Exit `0`; resolve all three catalogs to the shared plugin root without parent paths. |

Host discovery is a separate interactive check:

| Host | Command or state | Required inputs | Expected result |
| --- | --- | --- | --- |
| Codex | Add with `--json`, record `installedPath`, then start a new session with the exact `$heroes-agent` prompts above | Host login and the loaded repository catalog | Install JSON shows enabled state; the discovery response asks for tenant key and display name; onboarding preserves the exact display name and stops at blank `API_KEY`. |
| Claude Code | `claude plugin install heroes-agent@logic-heroes` | Claude login and the loaded repository catalog | Invoke `/heroes-agent:heroes-agent` successfully. |
| Cursor | `cursor-agent -p --plugin-dir <disposable-source>/plugins/heroes-agent --workspace <disposable-workspace> "<prompt>"` | Authenticated Cursor Agent CLI and a disposable archive source | Discovery asks for tenant key and display name; onboarding preserves both values exactly and stops at blank `API_KEY`. The account marketplace list is read-only and does not prove install. |

Run these checks from the repository root. They prove static package and catalog structure. They do not prove live host discovery.

Authenticated Heroes reads require a disposable tenant, its matching `API_KEY`, `API_URL`, network approval, and a known service ID. Mutation and recovery validation require two disposable tenants, valid service IDs and payloads, explicit human decisions, legal railway transitions, and mutation approval. Never print a key. Confirm the resulting state in Heroes. These external tests are not part of offline repository validation.

## Public-release checklist

- [x] Choose and add a license. Root `LICENSE` (Apache-2.0) and `NOTICE` are included.
- [x] Add the public repository and organization URLs to supported manifest fields.
- [x] Run all current offline validation commands. See `docs/release-evidence/slice-6-offline-gate.md`.
- [x] Test discovery on all three platforms. See `docs/release-evidence/slice-7-codex-smoke.md`, `docs/release-evidence/slice-8-claude-smoke.md`, and `docs/release-evidence/slice-9-cursor-smoke.md`.
- [x] Test HANDSHAKE against disposable Heroes tenants without exposing credentials. See `docs/release-evidence/slice-10-handshake.md`.
- [x] Test RFQ against disposable Heroes tenants without exposing credentials. See `docs/release-evidence/slice-11-rfq.md`.
- [x] Test the Heroes-shaped local rate contract and both existing tenant credentials. See `docs/release-evidence/slice-12-rate-contract.md`.
- [x] Confirm the archive contains no `.env`, secrets, signed download URLs, `.DS_Store`, broken symlinks, or machine-local paths. See the Slice 6 evidence.
- [x] Repeat the secret scan against the actual Git tracked-file set. The final Slice 6 gate scanned 54 tracked files.
- [x] Verify watcher step-change and attachment-only change behavior against the service API. See `docs/release-evidence/slice-10-handshake.md`.
- [x] Confirm marketplace ownership and public submission requirements for each platform. Publisher account setup and marketplace acceptance remain post-v1 work.
- [x] Review sample rate data before publication. The owner approved fictitious carrier identifiers and round example values in Slice 6.

The repository is licensed under Apache-2.0; see root `LICENSE` and `NOTICE`.
