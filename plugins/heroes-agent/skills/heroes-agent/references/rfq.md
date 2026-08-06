# Solicited RFQ railway

```text
REQUESTED -> QUOTED -> ACCEPTED
                ^  |
                |  v
             COUNTERED

REQUESTED, QUOTED, or COUNTERED may also end as REJECTED, CANCELLED,
WITHDRAWN, or EXPIRED when Heroes permits the actor's transition.
```

| Step | Actor | Bundled tool |
| --- | --- | --- |
| REQUESTED | requester/maker | `request-quotation.ts <payload-folder> --target <provider-key>` |
| QUOTED / re-QUOTED | provider/taker | `quote-request.ts <service-id> <quote-folder> --provider-ref <ref>` |
| COUNTERED | requester/maker | `counter-quotation.ts <service-id> --message <text>` |
| ACCEPTED | requester/maker | `accept-quotation.ts <service-id> --message <text>` |

The requester cannot quote and the provider cannot counter or accept. `providerRef` is required to quote. Price travels in the quote attachment or counter message; it is not a dedicated Heroes price field.

Before quoting, search the local rate book. An unambiguous filed match may be used automatically. A missing/stale/ambiguous rate or below-rate counter is a human pricing decision.

Watch after REQUESTED, QUOTED/re-QUOTED, and COUNTERED. ACCEPTED is terminal. Before any terminal rejection/cancellation/withdrawal not covered by a bundled helper, stop rather than invent an API call.
