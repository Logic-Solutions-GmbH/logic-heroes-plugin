# Choosing a service

A Heroes service is one promise between two parties for one kind of work. Choose the key from the promise being made, then confirm that the key exists in `GET /catalog/services`.

| Key | The promise |
| --- | --- |
| `oceanfreight` | Carry by sea. FCL, LCL, RoRo, and breakbulk all use this key. |
| `airfreight` | Carry by air. |
| `inland_transport` | Carry by road, rail, or barge. The vehicle records the mode. |
| `customs_clearance` | Obtain a customs result in any direction or country. |
| `terminal_handling` | Handle cargo at a port or airport terminal within the vessel or flight operation. |
| `warehouse_handling` | Receive, stuff or strip, pick, or release goods under a handling order. |
| `storage` | Keep goods safe and available for an agreed time. |
| `equipment_rental` | Provide equipment, including the empty-container loop and free time. |
| `insurance` | Cover the goods against risk. |
| `ownership_change` | Record the sale of the goods. This service carries the incoterm. |
| `freight_forwarding` | Carry the forwarder's overall responsibility to its customer. It has no milestones and is fulfilled by the services above. |

Use the promise to separate easily confused services:

- Terminal handling belongs to the vessel or flight operation. Warehouse handling follows a handling order. Storage promises custody for an agreed time. A site's label does not decide among them.
- Import and export customs work both use `customs_clearance`; direction is not part of the key.
- A carrier's own pre-carriage and on-carriage stay inside its `oceanfreight` or `airfreight` service. The Hapag-Lloyd door quote in [offer.md](offer.md) is one `oceanfreight` service.
- A forwarder's door-to-door quote fulfilled by a separate trucker, carrier, or customs broker is several sibling services in one offer.
- Demurrage, detention, free time, terminal handling charges (THC), fuel, duties, and the incoterm on a freight quote are charges or conditions on their service. They are not services of their own.
- Mixed FCL and LCL work in one quote is two `oceanfreight` services. One quote covering several container sizes stays one service with several `subtypes`.

When this peer creates a service, never choose a key that encodes direction, transport mode, or FCL/LCL, even when `GET /catalog/services` still lists that legacy key. If the right kind of work has no catalog template, stop and tell the human. Never substitute a legacy key: service keys cannot be changed after creation, and existing legacy services are not migrated.

These selection rules apply only to services this peer creates. Accept and answer a request or handshake from another peer whatever service key it already carries. Logic TMS still sends legacy keys such as `pre_carriage_ltl`, `ltl_pickup_origin`, and `ltl_pickup_destination`, as well as canonical keys such as `warehouse_handling`, to partner peers such as Leschaco. Do not refuse an incoming interaction because its key is legacy.
