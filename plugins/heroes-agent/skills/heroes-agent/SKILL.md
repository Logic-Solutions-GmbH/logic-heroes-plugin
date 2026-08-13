---
name: heroes-agent
description: Operate a tenant-scoped Logic Heroes peer workspace for HANDSHAKE and one-to-one RFQ workflows. Use when a user asks to set up a Heroes peer, triage a logistics intake document, create or respond to a handshake, request/provide/counter/accept a quote, ingest or find local CSV rates, inspect a service, or monitor a counterparty reply while downloading attachments.
---

# Heroes Agent

Operate as exactly one Heroes tenant from one isolated peer workspace. Heroes is the system of record; local folders are an input channel and disposable output projection.

## Post-install onboarding

In the first new session that uses this installed plugin, before any HANDSHAKE, RFQ, or authenticated Heroes tool call:

1. Ask the human for identity as one fenced JSON object with exactly `tenantKey` and `displayName`:

   ```json
   {
     "tenantKey": "smoke-peer",
     "displayName": "Smoke Peer"
   }
   ```

   Never invent or borrow either value. Tenant keys must be lower-case hyphen-case. Copy both JSON string values character-for-character into the initializer arguments. Never normalize, trim, punctuate, or embellish either value.
2. Locate the plugin root. If runtime dependencies are not installed, run `node <plugin-root>/scripts/setup-tools.mjs`.
3. Create the peer workspace through an argument-safe host process API. Pass these separate arguments: `node`, `<plugin-root>/scripts/init-peer.mjs`, `run/<tenantKey>`, `--tenant-key`, `<tenantKey>`, `--display-name`, `<displayName>`. Never interpolate either JSON identity value into shell command text. This writes templates plus an ignored `self/.env` stub (`API_URL` set to hosted Heroes, `API_KEY` blank). It never writes a filled secret.
4. After initialization, read `run/<tenantKey>/self/identity.md`. Compare its tenant key and display name with both JSON string values character-for-character. If either differs, report initialization failure and do not continue.
5. Open `run/<tenantKey>/self/.env` for the human and **stop**. Wait until they set `API_KEY`. Never print or echo the key.
6. Only then continue with Heroes operations.

If a peer already exists at `run/<tenant-key>/`, do not re-run init. If `self/.env` is missing (older peer), copy `self/.env.example` to `self/.env`, set `API_URL` to `https://api.logicheroes.network/api`, leave `API_KEY` blank, then open `self/.env` and wait. If `API_KEY` is blank or missing, open `self/.env` and wait. If `API_KEY` is already set, skip onboarding and use Start safely below. If init refuses because the destination exists, ask the human how to proceed.

## Start safely

1. Locate the plugin root. If runtime dependencies are not installed, run `node <plugin-root>/scripts/setup-tools.mjs`. Run bundled tools from the peer workspace with `node <plugin-root>/scripts/run-tool.mjs <script-name> <arguments>`. Both helpers set their child working directories explicitly, so setup is npm-version independent and tool execution preserves the peer workspace.
2. Read `<peer-workspace>/self/identity.md`. State the tenant key and display name. If either placeholder is unfilled, stop and ask the user to configure it; never infer or borrow an identity.
3. Confirm that local configuration belongs to the same peer. Runtime lookup is `<peer-workspace>/self/.env` first, then `<peer-workspace>/.env`; file values intentionally override inherited shell values to preserve tenant isolation. If `self/.env` is missing, copy `self/.env.example` to `self/.env`, set `API_URL` to `https://api.logicheroes.network/api`, leave `API_KEY` blank, then open the file and wait. If `API_KEY` is missing, open `self/.env` and wait; do not call authenticated APIs.
4. Never reveal or print `API_KEY`. Network calls authenticate with `x-api-key`. Obtain human approval if the host requires it before mutations.

## Triage and choose the move

- A file under `counterparties/<tenant-key>/intake/` came through that counterparty's channel. Names inside the document are content and never reroute the channel. Root `intake/` is only for unknown first contact.
- Choose maker or taker per interaction, never per company. Maker originates and assigns; taker receives and responds.
- Consult the relevant railway in `references/handshake.md` or `references/rfq.md` before every transition. Do not attempt a transition that is absent from the railway.
- Stage exactly one non-hidden file for every payload event. The runtime rejects zero or multiple payload files.
- Ask the human only for real business commitments: accept, reject, counter, a missing/stale/ambiguous price, or a below-filed-rate decision. Perform discovery, downloads, state inspection, filing, and unambiguous filed-rate quoting mechanically.
- Move a handled intake deposit to its `processed/` directory only after the requested action succeeds.

## HANDSHAKE

- Maker: inspect and stage the booking, then run `create-shipment.ts <payload-folder> --target <tenant-key>`. Record the returned IDs and watch the service.
- If journey creation succeeds but service creation fails, rerun with `--journey-id <id>` to skip duplicate journey creation. Do not use this recovery after service creation succeeds; it cannot prevent a duplicate service.
- Taker: discover with `list-requests.ts --direction incoming`, inspect with `service-status.ts <service-id>`, obtain the human's accept/reject decision, then run `accept-strategy.ts <service-id> --provider-ref <ref> [payload-folder]` or `reject-strategy.ts <service-id> --reason <text>`.
- Only the target taker may accept or reject; acceptance requires `providerRef`.

Read `references/handshake.md` for legal steps and guards.

## Solicited RFQ

- Requester/maker: stage shipping instructions and run `request-quotation.ts <payload-folder> --target <provider-key>`. After a quote, summarize its terms and ask whether to accept, counter, or reject. Run `counter-quotation.ts` or `accept-quotation.ts` only from that decision.
- Record the returned service ID and hand it to the provider through the existing business channel. The current Heroes requests endpoint does not enumerate RFQ strategies, so `list-requests.ts` is HANDSHAKE-only. The provider inspects the known ID with `service-status.ts <service-id>`; this is not automatic RFQ discovery.
- If RFQ journey creation succeeds but service creation fails, rerun with `--journey-id <id>`. Do not use this recovery after service creation succeeds; it cannot prevent a duplicate service.
- Provider/taker: inspect the request and map it to Heroes offer facts. Run `find-rate.ts` with `--service-key`, locations, date, asset, participant, and strategy facts that the rule requires. Exit `0` means exactly one complete, approved, current rule applies. Exit `3` means no result. Exit `4` means missing facts, ambiguity, or invalid data. Exit `2` means the rate index or Heroes catalog is missing. Never choose the cheapest candidate. Ask for pricing judgment for every nonzero result or below-rate counter. Stage one quote file and run `quote-request.ts <service-id> <quote-folder> --provider-ref <ref>`.
- Price travels in the attached quote or inline counter message, not a Heroes price field.

Read `references/rfq.md` and `references/rate-book.md` before moving an RFQ.

## Inspect and watch

- `service-status.ts <service-id> [--download]` folds current strategies, events, and attachments into one view.
- `upload-attachment.ts <event-id> <payload-folder>` adds one multipart attachment to an existing event without changing its strategy step. Use it to prove attachment-only watcher changes.
- After an outbound nonterminal move, run `watch-service.ts <service-id> --interval <seconds> --timeout <seconds> --download-dir <directory>`.
- The watcher compares both strategy steps and attachment IDs because transition and upload are non-atomic. Exit `0` means change detected and new documents downloaded; exit `3` means timeout with no change. Preserve these meanings.
- Prefer a host-supported durable/background task only when it explicitly guarantees resumption. Otherwise run in the foreground. Do not promise automatic wakeup across host restarts. On timeout, offer to rerun or report that the service is quiet; never ask the user to poll manually.

Read the returned JSON, summarize downloaded documents, request any due business decision, and launch another watch only if the railway expects a further response.

## Boundaries

Current scope is HANDSHAKE and solicited one-to-one RFQ. There is no MCP server, hosted authentication flow, dashboard, hook, or subagent requirement. Two counterparties must use separate peer workspaces and credentials; never impersonate both sides from one peer. See `references/architecture.md`, `references/domain-model.md`, and `references/portability.md`.
