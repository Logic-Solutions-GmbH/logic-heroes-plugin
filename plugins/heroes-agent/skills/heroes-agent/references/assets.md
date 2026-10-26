# Assets on a service

Asset-based tracking shows a service through the assets bound to it. A service with no bound asset does not appear there, even when its events and milestones are correct. Bind the shipment's assets to the service that carries the work and its milestones.

## When a shipment has two services of the same kind

Some chains create two services with the same key on one journey, for example:

- the **real** service, where the cargo owner assigns the work to the forwarder. Tracking information and milestone instances belong here. Bind assets here.
- an **integration-only (shadow)** service that exists only to connect another system to the journey. Do not bind assets to it, and do not post milestone events on it. Without assets it stays out of asset-based tracking.

Tracking may collapse services of the same kind into one group for the client. That is intended; binding assets only to the real service keeps the shadow one out of that group.

## Tool

```text
node <plugin-root>/scripts/run-tool.mjs link-service-assets.ts <service-id> \
  --asset <assetType>:<refType>:<refId> [--asset ...] [--name <text> ...] \
  [--role cargo|transport|document] [--expect-assignee <tenantKey>] [--dry-run] [--json]
```

Run it from the peer that may write the service manifest; the cargo owner or assigner is the usual choice. The asset is owned by the calling tenant.

For each `--asset` the tool:

1. Checks the type against `GET /catalog/asset-types`.
2. Looks the reference up with `GET /assets/{refId}`. It reuses the asset when the type and the `(refType, refId)` pair match. When a different asset already holds that reference, it stops without writing.
3. Otherwise creates it with `POST /assets` and `{ "type", "name", "externalRef": { "refType", "refId" } }`. Heroes answers 200 with the existing asset if the reference is already known, so this step never duplicates.
4. Reads `GET /services/{id}/assets/manifest`, posts only the missing pairs to `POST /services/{id}/assets/manifest` as `{ "entries": [{ "assetId", "role" }] }`, then reads the manifest back and fails if a pair is absent.

A re-run creates no asset and no manifest entry. `--dry-run` performs only the reads. `--expect-assignee` refuses to write unless the service's assignee is the named tenant, which keeps assets off the wrong service.

The role defaults from the asset type: vessel, plane, truck, train, barge, and trailer are `transport`; container, box, pallet, and cargo are `cargo`; document types such as `purchase_order`, `hbl`, `mbl`, `booking`, and `customs_declaration` are `document`. `--role` overrides it for every asset in the call. Heroes lists a bound document under `GET /services/{id}/assets` as well as in the manifest.

The same steps are available to scripts as `declareAsset`, `getServiceManifest`, and `linkServiceAssets` in `lib.ts`. `service-status.ts` prints the manifest.

## When to bind

Bind right after the service is created, before the first event on it. When the document that names the asset (for example the purchase order) is staged at creation, bind its asset then. When the asset only becomes known later (a container number arriving with a booking confirmation), bind it at that point with the same tool; do not create a placeholder asset to fill the gap. Never leave the real service unbound without saying so.

## Endpoints not used

- `POST /services/{id}/assets` binds cargo only (`cargoAssetIds`, optional `transportAssetId`) and cannot express the document role. It is not deprecated; use it only to tie cargo to a transport.
- `POST /journeys/{id}/assets` binds an asset to a journey trip, not to a service.
- `POST /journeys/{journeyId}/services` is deprecated; services are created with `POST /services`.

Reference: OpenAPI `info.version` 0.1.282 at `https://api.logicheroes.network/openapi`, documented at `https://api.logicheroes.network/docs#tag/assets`.
