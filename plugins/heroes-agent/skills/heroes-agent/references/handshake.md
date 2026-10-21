# HANDSHAKE railway

```text
INITIATED -> ACCEPTED
          -> REJECTED
          -> EXPIRED
```

| Step | Actor | Required value | Bundled tool |
| --- | --- | --- | --- |
| INITIATED | maker | `targetTenantKey` | `create-shipment.ts <payload-folder> --target example-taker --service-key <chosen-key> [--carriage <json-file>] [--collaborator example-collaborator]` |
| (after HANDSHAKE) | maker | `collaboratorTenantKey` | `add-service-collaborator.ts <service-id> --tenant-key example-collaborator` |
| ACCEPTED | named taker | `providerRef` | `accept-strategy.ts <service-id> --provider-ref <ref> [payload-folder]` |
| REJECTED | named taker | none | `reject-strategy.ts <service-id> [--reason <text>]` |

A collaborator is not a HANDSHAKE party. After HANDSHAKE, add one with `POST /services/{serviceId}/collaborators` and body `{ "collaboratorTenantKey": "example-collaborator" }`. `participantTenantKeys` on create has no collaborator role. Repeat `--collaborator` / `--tenant-key` for each tenant. If a collaborator call fails, the HANDSHAKE already exists; retry with `add-service-collaborator.ts <service-id> --tenant-key example-collaborator`.

Use `list-requests.ts --direction incoming` to discover addressed requests and `service-status.ts <service-id>` to inspect the complete service thread.

For `oceanfreight`, `airfreight`, or `inland_transport`, pass the request's carriage declaration
with `--carriage <json-file>`. The recipient reads it and its computed consistency from
`service-status.ts`; do not infer FCL/LCL/FTL/LTL from the service key or packaging text.

Only the taker named at INITIATED may accept or reject. A service may have only one open instance. Accepted services cannot be re-initiated. Rejected or expired services may be retried with a new INITIATED instance. Accept and reject are mutually exclusive.

After INITIATED, watch for the taker's terminal answer. ACCEPTED and REJECTED are terminal for this interaction.
