---
name: heroes-agent
description: Operate a tenant-scoped Logic Heroes peer workspace for HANDSHAKE, one-to-one RFQ, and held-quote OFFER workflows. Use when a user asks to set up a Heroes peer, triage a logistics intake document, create or respond to a handshake, request/provide/counter/accept a quote, compose a Heroes OFFER from a carrier quotation the peer already holds (compose-offer), ingest or find local CSV rates, inspect a service, or monitor a counterparty reply while downloading attachments.
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

## Supabase bootstrap

Use `references/supabase.md` when the human asks to connect private Supabase operational memory.

Ask for one explicit 20-character project reference. Never select by project name. Require blank-free `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` values in ignored `self/.env`. Never print them.

Preview first:

```text
node <plugin-root>/scripts/run-tool.mjs bootstrap-supabase.ts --project-ref <project-ref> --dry-run
```

Show the non-secret tenant, project name, region, and binding path. Apply only after the human confirms that target. Run the command again to prove a safe no-op. Never run `migration repair` automatically.

Before a Supabase rate adapter can use a user schema, read `references/supabase-rate-profile.md`. Only a human-confirmed profile bound to the current `self/supabase/binding.json` can be used. Discovery and proposal do not authorize schema changes.

## Triage and choose the move

- A file under `counterparties/<tenant-key>/intake/` came through that counterparty's channel. Names inside the document are content and never reroute the channel. Root `intake/` is only for unknown first contact.
- Choose maker or taker per interaction, never per company. Maker originates and assigns; taker receives and responds.
- A **priced document a counterparty already sent** is a held quote, not a request and not a rate import. File it with `compose-offer.ts`. Do not open an RFQ with `request-quotation.ts` (that opens `RFQ / REQUESTED` on a SHIPMENT) and do not push it through `ingest-rates.ts` or `rate-contract.ts` (local rate book only; they never write Heroes).
- Consult the relevant railway in `references/handshake.md`, `references/rfq.md`, or `references/offer.md` before every transition. Do not attempt a transition that is absent from the railway.
- Stage exactly one non-hidden file for every payload event. The runtime rejects zero or multiple payload files.
- Ask the human only for real business commitments: accept, reject, counter, a missing/stale/ambiguous price, or a below-filed-rate decision. Perform discovery, downloads, state inspection, filing, and unambiguous filed-rate quoting mechanically.
- Move a handled intake deposit to its `processed/` directory only after the requested action succeeds. CLI orchestration owns this move; a storage adapter only persists rows.

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
- Provider peer: inspect the request and map it to Heroes offer facts. Run `find-rate.ts` with `--service-key`, locations, date, asset, participant, and strategy facts that the rule requires. Exit `0` means exactly one complete, approved, current, valid rule applies. Exit `3` means no automatic result; no match, missing facts, or ambiguity requires human judgment. Exit `4` means invalid query or catalog data. Exit `2` means the rate index or Heroes catalog is missing. JSON returns at most 20 compact candidate summaries; check `candidateTotal` and `candidatesTruncated`. Never choose the cheapest candidate. Ask for pricing judgment for every nonzero result or below-rate counter. Stage one quote file and run `quote-request.ts <service-id> <quote-folder> --provider-ref <ref>`.
- Price travels in the attached quote or inline counter message, not a Heroes price field.

Read `references/rfq.md` and `references/rate-book.md` before moving an RFQ.

## Compose an OFFER from a held quote

- Use this when a counterparty has already sent a priced document and you want that quote in Heroes: `compose-offer.ts <offer-spec.json> [--attach <payload-folder>]`. It creates one `OFFER` journey, its services, and records `DIRECT_QUOTE / QUOTED` with an `offer_charges` payload in one call, then attaches the vendor document to the returned event.
- Offer parties are `issuer` (the offering party) and `recipient` (the party it was offered to). They are sent as `participantTenantKeys.issuer` / `.recipient`. Never remap them onto `assigner` / `assignee`: that is the assignment mechanic, a different relationship, and offer search already selects on the real one. If Heroes does not persist the pair, the helper releases what it created and stops — do not work around it.
- Fetch the closed vocabularies before filing: `GET /catalog/location-roles` and `GET /catalog/timeframe-kinds`. Never hard-code either list, and never read location roles out of `/openapi`.
- `origin` / `destination` are the ends of the whole service — an inland door on a door-to-door quote. `port_of_loading` / `port_of_discharge` are the main leg's ports; on a door-to-port quote the load port is neither the origin nor a transshipment. `transshipment` is a genuine mid-water vessel change.
- Prices never ride the facets. `amount` is a number; a `% of another line` is a computed amount plus optional `meta`, which Heroes stores and does not evaluate.
- Build the spec from the document, then run `--dry-run` first: it performs every read and check and prints the exact wire bodies without writing. Ask the human for any price you had to infer.
- Stop rather than substitute when the issuer has no Heroes tenant (`issuer_not_in_network`, exit `5`).
- Read the exit code as a statement about what remains in Heroes. Nothing remains on `2`, `4`, `5`, `6`, or `9` — `6` and `9` mean the run created something and then released it. The offer is recorded on `0` and on `8`, where only the document is missing: re-attach with `upload-attachment.ts <event-id> <folder>`. **`7` and `10` mean state may remain and a human has to look**: never rerun the command, because a retry mints a second offer. Check what is actually there with `POST /offers/search` or the Heroes UI, then resume with `--journey-id` or release by hand.
- `--journey-id` resumes exactly one case: the journey was minted and service creation had not succeeded. The helper refuses any other target, because the batch advance moves every service on the journey, not only the ones it created.

Read `references/offer.md` for the railway, the spec shape, the exit codes, and the worked example.

## Inspect and watch

- `service-status.ts <service-id> [--download]` folds current strategies, events, and attachments into one view.
- `upload-attachment.ts <event-id> <payload-folder>` adds one multipart attachment to an existing event without changing its strategy step. Use it to prove attachment-only watcher changes.
- After an outbound nonterminal move, run `watch-service.ts <service-id> --interval <seconds> --timeout <seconds> --download-dir <directory>`.
- The watcher compares both strategy steps and attachment IDs because transition and upload are non-atomic. Exit `0` means change detected and new documents downloaded; exit `3` means timeout with no change. Preserve these meanings.
- Prefer a host-supported durable/background task only when it explicitly guarantees resumption. Otherwise run in the foreground. Do not promise automatic wakeup across host restarts. On timeout, offer to rerun or report that the service is quiet; never ask the user to poll manually.

Read the returned JSON, summarize downloaded documents, request any due business decision, and launch another watch only if the railway expects a further response.

## Boundaries

Current scope is HANDSHAKE, solicited one-to-one RFQ, and filing a held quote as an OFFER. Instantiating an offer into a shipment (`POST /journeys/{offerId}/instantiate`) is out of scope: it requires `RFQ` + `ACCEPTED` on every service, and a direct-quote filing books nothing. There is no MCP server, hosted authentication flow, dashboard, hook, or subagent requirement. Two counterparties must use separate peer workspaces and credentials; never impersonate both sides from one peer. See `references/architecture.md`, `references/domain-model.md`, and `references/portability.md`.
