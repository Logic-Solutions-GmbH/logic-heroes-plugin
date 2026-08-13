# Heroes Agent

Heroes Agent lets one logistics peer use local evidence to make legal moves in Heroes.

## Language

**Peer**:
One company workspace with one Heroes tenant identity and one credential.
_Avoid_: Account, maker, taker

**Offer**:
A Heroes journey that describes provider work through one or more services.

**Rate catalog**:
A provider-owned local collection of approved rate cards. It is not shared Heroes state.
_Avoid_: Ledger, universal CSV

**Rate card**:
Local provider evidence for one offer shape. It groups rate rules under one approval and source record.
_Avoid_: Rate row

**Rate rule**:
One priced Heroes service with explicit applicability, charges, and conditions.
_Avoid_: Service family

**Applicability**:
The Heroes-shaped facts that determine whether a rate rule applies. These facts include service, locations, timeframes, assets, participants, and strategy.

**Charge**:
One monetary term with a charge key, currency, basis, flat or tiered amounts, and optional minimum and maximum.
_Avoid_: Total price

**Source evidence**:
The unchanged source identity and reference that support a rate card.
_Avoid_: Notes

**Catalog reference**:
The Heroes catalog snapshot that validated a rate card's controlled values.

**Approval**:
The human decision that permits a rate card to support deterministic discovery.
