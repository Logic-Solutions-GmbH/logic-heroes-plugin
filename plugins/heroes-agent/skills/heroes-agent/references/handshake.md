# HANDSHAKE railway

```text
INITIATED -> ACCEPTED
          -> REJECTED
          -> EXPIRED
```

| Step | Actor | Required value | Bundled tool |
| --- | --- | --- | --- |
| INITIATED | maker | `targetTenantKey` | `create-shipment.ts <payload-folder> --target <tenant-key>` |
| ACCEPTED | named taker | `providerRef` | `accept-strategy.ts <service-id> --provider-ref <ref> [payload-folder]` |
| REJECTED | named taker | none | `reject-strategy.ts <service-id> [--reason <text>]` |

Use `list-requests.ts --direction incoming` to discover addressed requests and `service-status.ts <service-id>` to inspect the complete service thread.

Only the taker named at INITIATED may accept or reject. A service may have only one open instance. Accepted services cannot be re-initiated. Rejected or expired services may be retried with a new INITIATED instance. Accept and reject are mutually exclusive.

After INITIATED, watch for the taker's terminal answer. ACCEPTED and REJECTED are terminal for this interaction.
