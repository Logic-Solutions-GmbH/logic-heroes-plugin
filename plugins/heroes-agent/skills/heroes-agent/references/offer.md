# OFFER railway — filing a quote you already hold

```text
DIRECT_QUOTE -> QUOTED
```

An `OFFER` journey records a quote that already exists. It is not a request, and it is not a
local rate card. Use it when a counterparty has sent you a priced document — a carrier PDF, a
spot rate mail, a tariff extract — and you want that quote to live in Heroes so it can be
searched, compared, and later instantiated.

| Step | Actor | Bundled tool |
| --- | --- | --- |
| QUOTED | the party recording the held quote | `compose-offer.ts <offer-spec.json> [--attach <payload-folder>]` |

## Choose this railway, not another one

| You have | Railway | Tool |
| --- | --- | --- |
| A priced document a counterparty sent you | `OFFER` / `DIRECT_QUOTE` / `QUOTED` | `compose-offer.ts` |
| A shipment you want someone to quote | `SHIPMENT` / `RFQ` / `REQUESTED` | `request-quotation.ts` |
| Your own approved price list, for local lookup | none — local files | `ingest-rates.ts`, `find-rate.ts` |

`request-quotation.ts` opens `RFQ / REQUESTED` on a **SHIPMENT**. A held quote is neither a
shipment nor a request, so that tool files the wrong journey type on the wrong railway.
`ingest-rates.ts` and `rate-contract.ts` only ever touch this peer's local rate book; they never
write Heroes. Neither is a substitute for composing an offer.

## Offer parties are `issuer` and `recipient`

Heroes carries two independent participant vocabularies on one service:

| Pair | Question it answers | Where it is used |
| --- | --- | --- |
| `assigner` / `assignee` / `observer` | who is assigned the work | HANDSHAKE, assignment |
| `issuer` / `recipient` | who offered it, and to whom | OFFER relationship |

| Commercial role | Heroes participant role | Example |
| --- | --- | --- |
| Offering party (the carrier that quoted you) | `issuer` | `hapag-lloyd` |
| Party the quote is offered to (this peer) | `recipient` | `hj-schryver-de` |

Send them on `POST /services` as `participantTenantKeys.issuer` and `.recipient`. Naming either
one turns **off** the implicit "the caller is the assigner" default, so a relationship-only body
writes relationship rows only — no assignment row is invented. **Never** remap `issuer` onto
`assignee` or `recipient` onto `assigner`. That stores a relationship nobody agreed to, and offer
search already selects on the real one.

`compose-offer.ts` reads back the `participants` array that `POST /services` returns and refuses
(`issuer_recipient_write_unavailable`, exit `6`) if the roles did not persist, releasing anything
it created. It never falls back to the assignment pair.

The strategy `role` on the advance is a different thing again: it is an assignment-side hint
naming who is recording the step. Omit it when this peer is the **recipient** filing a quote it
was given; `targetTenantKey` is then the **issuer**.

## Locations: the ends of the service, and the ports of the main leg

Fetch `GET /catalog/location-roles`. Every `locations[].role` must be a returned `code`. Do not
hard-code a role list, and do not read roles out of `/openapi`.

| Role | Means |
| --- | --- |
| `origin` | the start of the **whole service** — an inland door on a door-to-door quote |
| `destination` | the end of the whole service |
| `port_of_loading` | the ocean or air leg's load port |
| `port_of_discharge` | that leg's discharge port |
| `transshipment` | a genuine mid-water vessel change |
| `depot`, `warehouse` | the remaining catalog roles |

A door-to-port quote carries `origin` **and** `port_of_loading` together — the load port is
neither the origin nor a transshipment. A port-to-port quote may carry POL/POD only. Filing a
load port as `origin` mis-states where the service begins; filing it as `transshipment` invents a
vessel change that never happened.

## Timeframes

Fetch `GET /catalog/timeframe-kinds`. `timeframe_kind` is a closed vocabulary
(`validity`, `departure_window`, `arrival_deadline`, `cargo_ready`, `customs_clearance_by`), not
free text. `validity` is the kind the offer-library validity filter searches, so a quote with a
validity window should carry it.

`dateFrom` / `dateTo` go on the wire as ISO **strings** — `2024-10-16` or
`2024-10-16T00:00:00Z`. Never a `Date` object, never a locale format.

## Prices ride the advance, not the facets

Offer facets are price-free: Heroes has no charge-line or percentage catalog type. The quote's
money travels as the JSON `payload` of the `DIRECT_QUOTE / QUOTED` advance, in the same call:

```json
{
  "kind": "offer_charges",
  "schemaVersion": 2,
  "journeyId": "<offer-id>",
  "charges": [
    {
      "serviceRowId": "<local-row>",
      "heroesServiceId": "<service-uuid>",
      "chargeKey": "ocean-freight",
      "amount": 2063,
      "currency": "EUR"
    }
  ]
}
```

`amount` is a number. A line quoted as `% of another line` (23% fuel on the origin landfreight,
say) is a **computed** amount plus optional `meta` recording how it was derived. Heroes does not
evaluate `meta`; it stores it.

A binary vendor document (the carrier PDF) does not go in `payload`. Attach it to the returned
`eventId` with `POST /events/attachments` once the event exists.

## Resolve before any write

1. `GET /catalog/services` — the service key must exist.
2. `GET /catalog/asset-types`, `GET /catalog/asset-subtypes?asset_type=…` — map the carrier's
   equipment labels (`20'STD` → `20DC`, `40'STD` → `40DC`, `40'HC` → `40HC`).
3. `GET /catalog/location-roles` — every `locations[].role`.
4. `GET /catalog/timeframe-kinds` — every `timeframes[].kind`.
5. `GET /locodes/{code}` — every place code.
6. The issuer's tenant key: `GET /tenants/by-provider-code/{type}/{code}` (`scac/HLCU` →
   `hapag-lloyd`). `GET /tenants` is an admin list and 403s for a tenant API key.
   `GET /journeys/filter-options` only lists tenants already on journeys this key can see, so it
   is not a network directory either.

If the issuer has no tenant key, stop: `issuer_not_in_network` (exit `5`). Network identity is
not a workbench. `DIRECT_QUOTE` can file a quote the issuer never touches, but the issuer must
still exist as a Heroes tenant to be named as a participant. An issuer outside the network needs
enrolling, not inventing.

## Write order, and what to do when a step fails

1. `POST /journeys { "type": "OFFER" }` — **not idempotent**.
2. `POST /services` per service, with `participantTenantKeys`, `locations`, `timeframes`,
   `subtypes`.
3. `POST /journeys/{id}/strategy/advance` with `DIRECT_QUOTE` / `QUOTED` and the `offer_charges`
   payload, in one transactional call across every service of the journey.
4. `POST /events/attachments` for the vendor PDF, against the `eventId` the advance returned.
5. `POST /offers/search` to prove findability — including by `port_of_loading` /
   `port_of_discharge`, and by `participants: [{ tenantKey, role: "issuer" }]`.

**A lost `POST /journeys` response is never retried.** Retrying mints a second offer that nothing
links to the first. `compose-offer.ts` exits `7` and names what to reconcile; resume the run with
`--journey-id <id>` once the journey is identified. That resume target is checked first: it must be
an OFFER you own and it must still be empty, because the batch advance moves **every** service on
the journey, not only the ones this run created.

**Releasing a failed pre-advance attempt:** delete the services first, then the journey. Only a
journey this run minted is deleted — one supplied with `--journey-id` belongs to the caller and is
left alone. A journey that already carries a strategy instance is not deleted at all: the quote has
been recorded, and the fix is a forward correction.

**A release is only correct after a definitive rejection.** "Transactional" is not the same as
"observed": the advance can commit and then lose its response. Deleting on that guess erases a
filed quote, so an unknown outcome keeps everything and reports it instead.

## The offer spec

`compose-offer.ts` takes one JSON file so no business value is ever interpolated into shell
command text. Every controlled value in it is checked against the fetched catalogs before the
first write.

```json
{
  "reference": "W241001250784",
  "eventName": "Quotation W241001250784",
  "issuer": { "tenantKey": "hapag-lloyd" },
  "recipient": { "tenantKey": "hj-schryver-de" },
  "services": [
    {
      "rowId": "svc-1",
      "serviceKey": "oceanfreight",
      "locations": [
        { "code": "DELEV", "role": "origin", "sequence": 0 },
        { "code": "BEANR", "role": "port_of_loading", "sequence": 1 },
        { "code": "DOCAU", "role": "transshipment", "sequence": 2 },
        { "code": "KYGCM", "role": "port_of_discharge", "sequence": 3 },
        { "code": "KYGCM", "role": "destination", "sequence": 3 }
      ],
      "timeframes": [{ "kind": "validity", "dateFrom": "2024-10-16", "dateTo": "2024-11-30" }],
      "subtypes": ["20DC", "40DC", "40HC"],
      "charges": [
        { "chargeKey": "ocean-freight", "amount": 2063, "currency": "EUR" },
        {
          "chargeKey": "origin-fuel",
          "amount": 103.5,
          "currency": "EUR",
          "meta": { "basis": "23% of origin-landfreight", "of": 450 }
        }
      ]
    }
  ]
}
```

`issuer` may name the carrier by `tenantKey`, or by `providerCode` —
`{ "providerCode": { "type": "scac", "code": "HLCU" } }` — which the helper resolves through
`GET /tenants/by-provider-code`. `rowId` is your own local row identifier; it travels into
`offer_charges` beside the Heroes service id so a charge can always be traced back to the line
you read it from. `eventName` defaults to `Quotation <reference>`.

Run it with `--dry-run` first: the helper does every read and every check, prints the exact three
wire bodies, and writes nothing.

```text
compose-offer.ts <offer-spec.json> [--attach <payload-folder>] [--journey-id <id>] [--dry-run] [--json]
```

Every exit code says what remains in Heroes, because that is the only thing you have to
act on.

| Exit | What remains | Meaning |
| --- | --- | --- |
| `0` | the offer | composed, or `--dry-run` validated (which writes nothing) |
| `2` | nothing | a required catalog could not be read — do not proceed from memory |
| `4` | nothing | the spec, or the resume journey, was rejected before the first write |
| `5` | nothing | `issuer_not_in_network` — the offering party has no Heroes tenant |
| `6` | nothing | `issuer_recipient_write_unavailable` — the roles did not persist; the attempt was released |
| `9` | nothing | a create or the advance was definitively rejected; what this run made is gone |
| `7` | **maybe a journey** | `journey_create_unconfirmed` — its id was never seen |
| `10` | **maybe an offer** | an outcome was lost, or a release did not finish; the ids are in the output |
| `8` | the offer | `attachment_failed` — only the document is missing; re-attach with `upload-attachment.ts <event-id> <folder>` |
| `1` | unknown | unexpected error |

`7` and `10` are the two codes that need a human. Neither is ever retried: a retry mints
a second offer, and the correct next move is to look at what is actually there
(`POST /offers/search`, or the Heroes UI) and then finish or release it by hand.

The distinction behind `9` and `10` is what the server told us. A `4xx` means it read the
request and refused it, so nothing was committed and the run releases what it created. A
lost response or a `5xx` may sit on either side of the commit — compensating there would
delete a quote that is already filed, so nothing is touched.

## Do not

| Wrong move | Why |
| --- | --- |
| `request-quotation.ts` | Opens `RFQ / REQUESTED` on a **SHIPMENT** |
| `ingest-rates.ts` / `rate-contract.ts` | Local rate book only; never writes Heroes |
| `POST /services/{id}/events` + `loCode` to set the lane | Events stamp milestones; offer-library locations are created on the service |
| `GET /tenants` | Admin list; a tenant API key gets 403 |
| Retrying `POST /journeys` after a lost response | Mints a second offer |
| Teaching assigner/assignee as the offer parties | Wrong vocabulary; offer search selects on issuer/recipient |
| Scraping `/openapi` for `locodes[].role` | Replaced by `GET /catalog/location-roles` |
| Hard-coding location roles or timeframe kinds | Closed Heroes vocabularies; fetch them |
| Filing POL as `origin` or `transshipment` | Mis-tags the door, or invents a vessel change |
| Splitting one quote into a service per container size | `subtypes` covers the equipment on one service |

## Worked example

Hapag-Lloyd door quote `W241001250784`, Leverkusen door → Grand Cayman, via Antwerp and Caucedo,
quoted for three box sizes and stated as service 1 of 1:

- One `OFFER` journey, one `oceanfreight` service.
- `subtypes: ["20DC", "40DC", "40HC"]` — one service, three covered sizes, not three services.
- Locations:

  | Place | UN/LOCODE | Role |
  | --- | --- | --- |
  | Door / place of receipt | `DELEV` | `origin` |
  | Ocean load port | `BEANR` | `port_of_loading` |
  | Intermediate ocean call | `DOCAU` | `transshipment` |
  | Ocean discharge port | `KYGCM` | `port_of_discharge` |
  | Place of delivery | `KYGCM` | `destination` |

  The quote ends at the discharge port, so `KYGCM` carries two roles: it is the main
  leg's discharge port **and** the end of the service. Both rows are filed. A quote that
  ran on to an inland door would name that door as `destination` instead, and `KYGCM`
  would stay `port_of_discharge` alone. Never leave a service without a `destination`
  because a port happens to be its last stop.

- Timeframe: `{ "kind": "validity", "dateFrom": "2024-10-16", "dateTo": "2024-11-30" }`.
- `issuer`: `hapag-lloyd` (SCAC `HLCU`). `recipient`: the filing peer, e.g. `hj-schryver-de`.
- Charges ride the advance; the PDF is attached to the event it returns.

Afterwards, `POST /offers/search` with `{"locodes":[{"code":"BEANR","role":"port_of_loading"}]}`
must return this offer.

## Out of scope

`POST /journeys/{offerId}/instantiate` needs `RFQ` + `ACCEPTED` on every service. A direct-quote
filing records a price; it does not book anything. Instantiating is a separate, later decision.
