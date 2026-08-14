# Domain model

- A **peer** is one company, one workspace, one tenant key, and one Heroes API key.
- **Maker** and **taker** describe a single move. The maker brings and assigns business; the taker accepts and performs it. Either peer can take either role on a different deal.
- A **journey** is the shipment-level container. A **service** is a piece of work within it.
- A **strategy railway** constrains legal service transitions. Its current position, events, and attachments live in Heroes.
- A local **deposit** is a trigger. Its folder identifies the sender channel; its document contents describe business participants and assets.
- An event may carry a small text-like payload inline. Larger or binary payloads are uploaded as attachments after event creation.
- A local **rate catalog** is provider-owned pricing evidence, not Heroes state.
- A **rate card** groups one or more approved rate rules under one source record.
- A **rate rule** prices one Heroes service. Its applicability uses Heroes service keys, locations, timeframes, assets, participants, and strategy.
- A **charge** is one monetary term with a key, currency, basis, flat or tiered amounts, and optional bounds. A rule can contain several charges.
- A **catalog reference** proves which Heroes catalog snapshot validated the controlled values.

The filesystem is interface, not authoritative storage. Do not reconstruct remote state from local archive folders; inspect the service instead.
