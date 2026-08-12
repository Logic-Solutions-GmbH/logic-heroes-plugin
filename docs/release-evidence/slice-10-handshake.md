# Slice 10 two-tenant HANDSHAKE evidence

The live test started from baseline commit
`15c88d248522a368cdd987525e803537a275bbbf`. Two owner-confirmed test
tenants used separate persistent peer workspaces and separate credentials.
This file calls them `tenant-a` and `tenant-b`.

This file contains no API key, credential header, owner identity, signed URL,
payload content, absolute private path, or remote record identifier.

## Public seams

All live actions used bundled public commands through `run-tool.mjs`:

```text
create-shipment.ts <payload-folder> --target <tenant-key> [--journey-id <id>]
list-requests.ts --direction incoming|outgoing
service-status.ts <service-id> [--download --download-dir <directory>]
accept-strategy.ts <service-id> --provider-ref <ref> [payload-folder]
reject-strategy.ts <service-id> --reason <text>
watch-service.ts <service-id> --interval 2 --timeout 120 --download-dir <directory>
upload-attachment.ts <event-id> <payload-folder>
```

The owner approved two permanent disposable HANDSHAKE records, four synthetic
uploads, both terminal moves, invalid-action probes, reads, watchers, and
downloads. The plugin has no public remote deletion command, so the test
records remain in the test tenants.

## Recovery and red-green proof

The first `tenant-a` creation call created its journey, then service creation
failed with `404`. No service, strategy, or upload existed at that point. The
failure exposed three package defects:

- structured error bodies rendered as `[object Object]`;
- the command could not resume after partial journey creation;
- the default service key `OCEAN_FREIGHT` was not accepted by the live API.

Red tests reproduced the first two defects. One showed `409 [object Object]`.
The other showed that resume still called `POST /journeys`. After the fix,
structured errors exposed safe detail, and `--journey-id` skipped journey
creation while preserving service, strategy-event, and multipart behavior.

A separate red test expected the live-proven service key
`ltl_pickup_origin` but received `OCEAN_FREIGHT`. The corrected default made
that test pass. Recovery then reused the existing journey and created the
first HANDSHAKE without another orphan journey.

## Interaction A: tenant-a makes, tenant-b accepts

Both peer views showed the same open request:

```text
HANDSHAKE / INITIATED
```

The maker attempted `ACCEPTED`. The API refused it with status `400` because
only the expected HANDSHAKE actor can accept. Both peer lists remained
`INITIATED`.

The maker watcher started before the taker action. The taker accepted with a
synthetic provider reference and confirmation document. The watcher exited
`0` and reported:

```text
HANDSHAKE/INITIATED -> HANDSHAKE/ACCEPTED
```

It also downloaded the confirmation. The independent source and downloaded
SHA-256 values matched:

```text
32db25153c1d12bd3c825a9f4364c74256602c8a2cb61b5f6b3a6f2d74462081
```

Both peers then inspected `HANDSHAKE / ACCEPTED`. A taker attempt to reject the
accepted interaction failed with status `400`. The service remained
`ACCEPTED`.

## Attachment-only watcher proof

The maker started another watcher from the accepted baseline. The taker used
`upload-attachment.ts` to add one synthetic multipart document to the existing
accepted event. No strategy event was created.

The watcher exited `0`, downloaded the new file, and reported:

```json
{
  "changed": true,
  "stepChanges": [],
  "newAttachments": [{ "file": "attachment-only.txt" }],
  "steps": { "<instance-id>": "HANDSHAKE/ACCEPTED" }
}
```

The independent source and downloaded SHA-256 values matched:

```text
5a82afe537a03813e90c24acd8d3309c8267857df8808cb63704974c1a0dc56c
```

This proves that the watcher detects a document change without a strategy-step
change.

## Interaction B: tenant-b makes, tenant-a rejects

Both peer lists showed the reverse request at `HANDSHAKE / INITIATED`.
`tenant-a` downloaded the initial booking. The independent source and
downloaded SHA-256 values matched:

```text
417df3e05448f94eeb4660e3b0134dee2a12c5dda8f7edec7314aef70b6ce966
```

The maker attempted `REJECTED`. The API refused it with status `400` because
only the expected actor can reject. The interaction remained `INITIATED`.

The maker watcher started before the taker action. The taker rejected with a
synthetic reason. `reject-strategy.ts` reported
`rejection-reason.txt (inline)`. The live API exposed that generated payload
as an attachment. The watcher downloaded it, exited `0`, and reported:

```text
HANDSHAKE/INITIATED -> HANDSHAKE/REJECTED
```

The maker inspected `HANDSHAKE / REJECTED`. After rejection, the taker had no
incoming request and `service-status.ts` returned `404`. Its attempted
`ACCEPTED` reversal also returned `404`; the maker still saw `REJECTED`.

The rejecting taker's loss of service visibility is observed current API
behavior. It does not change terminality, but it limits two-sided inspection
after rejection. The maker view and successful maker watcher provide the
durable final-state evidence for this branch.

## Validation test: pass

The two directions reached the required terminal results:

```text
tenant-a -> tenant-b: INITIATED -> ACCEPTED
tenant-b -> tenant-a: INITIATED -> REJECTED
```

Both wrong-actor actions failed and left the open state unchanged. Both
terminal reversal attempts failed. State watchers exited `0`. The
attachment-only watcher exited `0` with no step change. All three independent
source/download hash comparisons matched.

## Understanding test: pass

One peer workspace and credential represent one tenant. Maker and taker roles
change with each interaction. Only the named taker can end an open HANDSHAKE.
`ACCEPTED` and `REJECTED` are mutually exclusive terminal outcomes for one
interaction. Heroes state, not a local file, decides the legal next move.

The evidence proves actor enforcement, both legal terminal branches, terminal
non-reversal, watcher step detection, attachment-only detection, and exact
document transfer. It does not prove remote record deletion or taker access to
a rejected service.
