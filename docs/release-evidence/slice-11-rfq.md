# Slice 11 two-tenant RFQ evidence

The live test started from baseline commit
`2aa838d0fc523071a452fbeb4180b3727b00e568`. It reused the two
owner-confirmed test tenants and separate peer workspaces from Slice 10. This
file calls them `tenant-a` and `tenant-b`.

This file contains no API key, credential header, owner identity, signed URL,
payload content, absolute private path, or remote record identifier.

Runtime used for the controller commands and final local gate:

```text
Node.js v26.4.0
npm 11.17.0
Darwin 25.5.0 arm64
git 2.50.1 (Apple Git-155)
```

## Approved public seams and decisions

All actions used bundled commands through `run-tool.mjs`:

```text
request-quotation.ts <payload-folder> --target <tenant-key> [--journey-id <id>]
quote-request.ts <service-id> <payload-folder> --provider-ref <ref>
counter-quotation.ts <service-id> <payload-folder> --message <text>
accept-quotation.ts <service-id> <payload-folder> --message <text>
service-status.ts <service-id> [--download --download-dir <directory>]
watch-service.ts <service-id> --interval 2 --timeout 120 --download-dir <directory>
```

The owner approved one permanent disposable RFQ record, synthetic documents,
the prices `USD 1250`, `USD 1175`, and `USD 1200`, provider references
`SLICE11-Q1` and `SLICE11-Q2`, final acceptance, invalid-action probes, reads,
watchers, and downloads. The plugin has no public remote deletion command, so
the test record remains in the test tenants.

## Pre-live red-green proof

Public-launcher tests first showed that RFQ recovery still called
`POST /journeys`, a missing `--journey-id` value still made remote requests,
and the default service key was `oceanfreight` instead of the live-proven
`ltl_pickup_origin`.

After the minimal fixes:

- `--journey-id` skips journey creation and preserves service, event, and
  attachment behavior;
- a missing recovery value exits before any request;
- the default service key is `ltl_pickup_origin`;
- public-launcher tests cover request, quote and re-quote, counter, acceptance,
  and watcher download behavior.

The pre-live full package gate passed 15 of 15 tests, typecheck, helper
integration, and diff checks.

## Live railway

The approved interaction used `tenant-a` as requester and `tenant-b` as
provider:

```text
REQUESTED -> QUOTED -> COUNTERED -> QUOTED -> ACCEPTED
```

### REQUESTED

`tenant-a` created a shipment, service, and `RFQ / REQUESTED` event addressed
to `tenant-b`. `tenant-b` inspected the service by its returned service ID and
downloaded the synthetic request document. Independent source and downloaded
SHA-256 values matched:

```text
49cf31847fbcbd770d4a0d5e8c22864ad9a1aeb7d0fe23269c0e1ccaf7ab8335
```

The requester attempted to quote its own request. The API refused it with
status `400` because only the expected RFQ actor can record `QUOTED`. The
service remained `REQUESTED`.

### Initial QUOTED

The requester watcher started before the provider move. `tenant-b` posted the
approved `USD 1250` quote with provider reference `SLICE11-Q1` and one
document. The watcher exited `0`, downloaded the quote, and reported:

```text
RFQ/REQUESTED -> RFQ/QUOTED
```

The independent source and downloaded SHA-256 values matched:

```text
7d8c9bc50a3e3d9b53d2841dba2ce64c8281a95272ab367275100650917bb8be
```

The provider attempted to counter its own quote. The API refused it with
status `400` because only the expected RFQ actor can record `COUNTERED`.

### COUNTERED

The provider watcher started before the requester move. `tenant-a` posted the
approved `USD 1175` counter and one document. The watcher exited `0`,
downloaded the counter, and reported:

```text
RFQ/QUOTED -> RFQ/COUNTERED
```

The independent source and downloaded SHA-256 values matched:

```text
508044d8d2367748df4e74942535da2c62ececb6a8d3937904b820d9730a2888
```

### Revised QUOTED

The requester watcher started before the provider move. `tenant-b` posted the
approved revised `USD 1200` quote with provider reference `SLICE11-Q2` and one
document. The watcher exited `0`, downloaded the revised quote, and reported:

```text
RFQ/COUNTERED -> RFQ/QUOTED
```

The independent source and downloaded SHA-256 values matched:

```text
2360a85551a235a082d331f14e68af0ff864ad4beac74933996419f70ceb0b24
```

### ACCEPTED

The provider watcher started before the requester move. `tenant-a` accepted
the approved revised `USD 1200` quote and attached one acceptance document.
The watcher exited `0`, downloaded the acceptance, and reported:

```text
RFQ/QUOTED -> RFQ/ACCEPTED
```

The independent source and downloaded SHA-256 values matched:

```text
2259924f55680c307a64615ea6f3636fdd2d262a3fa402ca06022b8818e7bf97
```

Both peers then inspected the full event thread at `RFQ / ACCEPTED`. The
requester attempted a post-terminal counter. The API refused it with status
`400` because there was no active RFQ instance. The service remained
`ACCEPTED`.

## Discovery boundary

`list-requests.ts --direction incoming|outgoing` returned no rows for this RFQ,
although `tenant-b` could inspect the addressed service through its known ID.
The plugin has no documented public RFQ enumeration endpoint. The current
truthful workflow is therefore an explicit service-ID handoff through the
existing business channel, followed by `service-status.ts`.

This is an API discovery limit, not a railway or access failure. The operator
manual, shared skill, RFQ reference, and command description now state that
`list-requests.ts` is HANDSHAKE-only. No private or guessed route was used.

## Validation test: pass

The two test tenants completed the approved one-to-one RFQ:

```text
REQUESTED -> QUOTED -> COUNTERED -> QUOTED -> ACCEPTED
```

All four watchers exited `0` at the expected transition. Five independent
source/download hash comparisons matched. The requester could not quote, the
provider could not counter, and the requester could not counter after
acceptance. The state remained legal after every invalid action.

## Understanding test: pass

The requester owns `REQUESTED`, `COUNTERED`, and `ACCEPTED`. The named provider
owns `QUOTED` and supplies the provider reference. Each move changes one shared
RFQ instance. The most recent legal quote is the one the requester accepts.
Heroes state, not local documents, decides the next legal action.

The evidence proves actor enforcement, re-quotation after a counter, terminal
acceptance, watcher behavior, and exact document transfer. It does not prove
automatic RFQ discovery or remote record deletion.
