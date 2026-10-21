# Logic TMS transport order (ServiceRequest v3)

Use this railway **only when the human explicitly asks** for Logic TMS, Schryver TMS, `transportOrder`, or **ServiceRequest v3 XML**. Default heroes-agent work stays on the **Heroes JSON API** (`create-shipment`, RFQ, OFFER, etc.). There is no Heroes tenant flag for “uses TMS”; prompt-gated opt-in is intentional.

## Contract files (bundled)

| File | Role |
| --- | --- |
| `service-request-v3/ServiceRequest.v3.xsd` | Schema for `GET /api/heroes/transportOrder` (logic-core `TransportOrderXmlBuilderService`) |
| `service-request-v3/ServiceRequest.v3.full-example.xml` | Synthetic full instance (validates against the XSD) |

Discover paths from any peer workspace:

```bash
node <plugin-root>/scripts/run-tool.mjs transport-order-contract.ts
node <plugin-root>/scripts/run-tool.mjs transport-order-contract.ts --validate ./outbox/my-order.xml
```

Snapshot vendored in this plugin: **2026-10-21**. Refresh when logic-core changes the builder. Related captures live in `logic-core/docs/service-request-v3/` (examples only; XSD is shipped here for agents).

## Boundaries

- **Generating XML** for TMS intake is in scope when requested. Write under the peer (e.g. `outbox/transport-order.xml`). Follow the XSD and the full example; empty nodes may be omitted in real payloads (builder omits empty values).
- **Submitting** XML to Schryver TMS is **out of scope** for the plugin until a dedicated TMS API tool exists (separate credentials).
- Do **not** use this path for HANDSHAKE: `create-shipment.ts` posts JSON events to Heroes, not ServiceRequest XML.

## Field glossary (XML ↔ Heroes concepts)

| XML | Meaning |
| --- | --- |
| `Issuer/TenantKey` | Schryver branch issuing the order (maker peer identity) |
| `Partner/TenantKey` | Network partner tenant (often HANDSHAKE `--target` or `--collaborator` — decide from the business case) |
| `Parties/Shipper`, `Consignee` | Commercial names/addresses; not `participantTenantKeys` |
| `Booking/JourneyID` | Heroes journey UUID |
| `ServiceRequested/Key` | Service template key (`sea_fcl`, `pre_carriage`, …) |
| `ServiceRequested/ServiceID`, `Services/Service/ServiceID` | Heroes service UUIDs (inspect with `service-status.ts`) |

## Agent workflow

1. Run `transport-order-contract.ts` for paths (or read this guide + open XSD/example).
2. Draft XML from business inputs; use the full example for shape (nested cargo, DGD, routes, Carta Porte).
3. Optional: `--validate <file>` (requires `xmllint` on the host).
4. Hand off to the operator or a future TMS submit tool for posting into Logic TMS.
