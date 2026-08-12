# Heroes Agent

Heroes Agent connects a local Codex, Claude Code, or Cursor agent to one Logic Heroes tenant.

It processes logistics documents, follows allowed HANDSHAKE and RFQ state changes, uses a local rate book, and monitors replies and attachments.

For installation details, onboarding, prompts, validation, and operational guidance, read the **[Heroes Agent operations manual](plugins/heroes-agent/README.md)**.

## The problem

Logistics work often arrives as documents, while the legal business state lives in Heroes.

A deposit is a document placed in local intake. The plugin reads it, but never treats local files as authoritative business state.

Each company is a peer. One peer uses one workspace, tenant key, and API key.

Within one interaction, the maker assigns business and the taker responds. Either peer can take another role in a different interaction.

Heroes groups a shipment in a journey. A service is one piece of work within that journey.

A railway defines the allowed service state changes. The agent checks it before acting.

The agent can automate discovery and clear rate matches. A human decides acceptance, rejection, counters, and exceptional pricing.

Heroes is the system of record. Local folders hold intake, identity, configuration, rates, processed documents, and downloaded copies.

## How it works

### HANDSHAKE

1. The sender stages one booking document and creates a shipment for a named recipient.
2. The sender records the journey and service identifiers, then watches for changes.
3. The recipient discovers and inspects the incoming service.
4. A human chooses acceptance or rejection.
5. The recipient supplies a provider reference when accepting, or rejects the request.

### Solicited one-to-one RFQ

1. The requester stages shipping instructions and requests a quotation from one provider.
2. The provider inspects the request and searches its local rate book.
3. The provider uses a clear, current rate match or asks for human judgment.
4. The provider sends one quote attachment and its provider reference.
5. The requester reviews the terms. A human directs acceptance, counter, or rejection.
6. Either peer watches the service whenever it expects another reply.

Price belongs in the quote attachment or counter message. Heroes has no dedicated price field for this workflow.

## Supported agents and boundaries

The plugin supports local Codex, Claude Code, and Cursor agents through host-specific adapters and one shared runtime.

The current scope is HANDSHAKE and solicited one-to-one RFQ.

One workspace represents exactly one tenant and credential. Two counterparties require separate workspaces. The plugin must never impersonate both peers.

Foreground watching is the portable baseline. Host approvals differ, and durable wake or resume after a host restart is not promised.

This plugin has no MCP server, hosted authentication flow, dashboard, hooks, custom UI, or subagent requirement. Browser-based ChatGPT operation needs a separate hosted design and is not implemented.

The local rate book is provider-owned input, not Heroes state. Bundled sample rates are examples, not live offers.

## Install from the repository catalogs

Node.js 18 or newer is required. Run these commands from the repository root.

### Codex

```sh
codex plugin marketplace add . --json
codex plugin add heroes-agent@logic-heroes --json
codex plugin list --json
```

Record `installedPath` from the `codex plugin add heroes-agent@logic-heroes --json` result. Start a new Codex session after installation.

First, prove skill discovery without file or network work:

```text
Use $heroes-agent. Read its installed instructions. State the two human values required before peer initialization. Do not create files or call a network service.
```

The next prompt uses `smoke-peer` and `Smoke Peer` as examples. Replace both with the exact operator-supplied values:

```text
Use $heroes-agent. Create one peer workspace at run/smoke-peer. The tenant key is smoke-peer. The display name is Smoke Peer. Preserve the display name exactly. Do not use a network service. Stop when a Heroes API key is required.
```

The install JSON proves catalog state. The new-session response proves skill discovery and use.

### Claude Code

```sh
claude plugin validate . --strict
claude plugin validate plugins/heroes-agent --strict
claude plugin marketplace add .
claude plugin install heroes-agent@logic-heroes
```

Invoke the skill as `/heroes-agent:heroes-agent` in a new session.

### Cursor

Cursor teams can import this public repository through **Dashboard > Plugins > Import from Repo**. The catalog is `.cursor-plugin/marketplace.json`.

For a direct local load, copy or link `plugins/heroes-agent` to `~/.cursor/plugins/local/heroes-agent`. Restart Cursor or run **Developer: Reload Window**.

Live host discovery remains part of the later host smoke-test slices.

## First run

Record the host plugin root. Codex uses the `installedPath` from `codex plugin add heroes-agent@logic-heroes --json`. A repository checkout uses `plugins/heroes-agent`.

Set up the shared tools, then initialize one peer workspace:

```sh
plugin_root="<host plugin root>"
tenant_key="example-peer"
display_name="Example Peer"
node "$plugin_root/scripts/setup-tools.mjs"
node "$plugin_root/scripts/init-peer.mjs" "run/$tenant_key" --tenant-key "$tenant_key" --display-name "$display_name"
```

Replace the two example values before initialization. The tenant key must use lowercase hyphen-case.

Initialization refuses to overwrite an existing destination. It creates `self/.env` inside the new workspace with the hosted `API_URL` and a blank `API_KEY`.

The human must set `API_KEY` locally in that ignored file. The agent must never print the key. Authenticated Heroes work must wait until the key exists.

Continue with the **[full operations manual](plugins/heroes-agent/README.md)** after initialization.

## License

Licensed under the [Apache License 2.0](LICENSE). See the [copyright notice](NOTICE).
