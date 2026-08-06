# Domain model

- A **peer** is one company, one workspace, one tenant key, and one Heroes API key.
- **Maker** and **taker** describe a single move. The maker brings and assigns business; the taker accepts and performs it. Either peer can take either role on a different deal.
- A **journey** is the shipment-level container. A **service** is a piece of work within it.
- A **strategy railway** constrains legal service transitions. Its current position, events, and attachments live in Heroes.
- A local **deposit** is a trigger. Its folder identifies the sender channel; its document contents describe business participants and assets.
- An event may carry a small text-like payload inline. Larger or binary payloads are uploaded as attachments after event creation.
- A local rate book is a provider-owned pricing input, not Heroes state.

The filesystem is interface, not authoritative storage. Do not reconstruct remote state from local archive folders; inspect the service instead.
