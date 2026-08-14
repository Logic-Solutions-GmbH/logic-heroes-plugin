/**
 * compose-offer — file a quote you already hold as a Heroes OFFER journey.
 *
 * A received carrier quotation is neither an RFQ nor a local rate card: it is a
 * priced document a counterparty issued to this peer. It belongs on an `OFFER`
 * journey, recorded with `DIRECT_QUOTE / QUOTED`, with the offer relationship
 * named as `issuer` / `recipient` — never remapped onto assigner/assignee.
 *
 * Usage:
 *   npx tsx compose-offer.ts <offer-spec.json> [--attach <payload-folder>] \
 *       [--journey-id <id>] [--dry-run] [--json]
 *
 * Exit codes. Every one of them says what remains in Heroes, because that is the
 * only thing the caller has to act on:
 *
 *   NOTHING WAS WRITTEN
 *   0  offer composed (or --dry-run validated)
 *   2  a required Heroes catalog could not be read
 *   4  the spec, or the resume journey, was rejected before the first write
 *   5  issuer_not_in_network — the offering party has no Heroes tenant key
 *
 *   WRITTEN, THEN FULLY RELEASED — nothing remains
 *   6  issuer_recipient_write_unavailable — Heroes did not persist the roles
 *   9  a create or the advance was definitively rejected; what this run made is gone
 *
 *   STATE MAY REMAIN — reconcile before refiling, and do not rerun
 *   7  journey_create_unconfirmed — the journey may or may not exist
 *  10  an outcome was lost (or a release did not finish); ids are in the output
 *
 *   THE QUOTE IS RECORDED
 *   8  attachment_failed — only the document is missing; re-attach with upload-attachment.ts
 *
 *   1  unexpected error
 *
 * See references/offer.md for the railway, the vocabularies, and the worked example.
 */
import {
  run,
  parseArgs,
  flagString,
  requireApiKey,
  api,
  ApiError,
  readPayloadFolder,
  uploadAttachment,
  heading,
  kv,
  type Config,
} from './lib';
import { existsSync, readFileSync } from 'node:fs';
// One definition of what Heroes accepts. `isIsoDate` / `isIsoDateTime` mirror the
// server's `z.iso.date()` / `z.iso.datetime()` — real calendar dates, and `Z` only,
// because a numeric offset is rejected there.
import { ISO_CURRENCIES, isIsoDate, isIsoDateTime } from './rate-contract';

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

interface SpecLocation {
  code: string;
  role: string;
  sequence?: number;
}

interface SpecTimeframe {
  kind: string;
  dateFrom?: string;
  dateTo?: string;
}

interface SpecCharge {
  chargeKey: string;
  amount: number;
  currency: string;
  meta?: unknown;
}

interface SpecService {
  rowId: string;
  serviceKey: string;
  locations?: SpecLocation[];
  timeframes?: SpecTimeframe[];
  subtypes?: string[];
  charges?: SpecCharge[];
}

interface OfferSpec {
  reference?: string;
  eventName?: string;
  issuer: { tenantKey?: string; providerCode?: { type: string; code: string } };
  recipient: { tenantKey: string };
  services: SpecService[];
}

/**
 * `2026-07-01` or `2026-07-01T00:00:00Z` — exactly what Heroes accepts on the wire.
 * A numeric offset (`+02:00`) and an impossible date (`2026-02-31`) both fail here,
 * so `--dry-run` proves the write will pass rather than only that it looks plausible.
 */
function isIsoWireDate(value: unknown): boolean {
  return typeof value === 'string' && (isIsoDate(value) || isIsoDateTime(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * A typed stop with its own exit code. Thrown and unwound rather than exiting on
 * the spot: calling `process.exit` mid-run tears the process down while its HTTP
 * sockets and buffered stdout are still live.
 */
class Refusal extends Error {
  constructor(
    readonly exitCode: number,
    readonly output: Record<string, unknown>,
  ) {
    super(String(output.reason ?? 'refused'));
    this.name = 'Refusal';
  }
}

function refuse(code: number, reason: string, detail: Record<string, unknown> = {}): never {
  throw new Refusal(code, { status: 'refused', reason, ...detail });
}

/**
 * Structural validation only — every controlled value is checked against the
 * fetched Heroes catalogs afterwards, never against a list hard-coded here.
 */
function readSpec(path: string): { spec?: OfferSpec; issues: string[] } {
  if (!existsSync(path)) return { issues: [`offer spec not found: ${path}`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { issues: [`offer spec is not valid JSON: ${(error as Error).message}`] };
  }
  if (!isRecord(parsed)) return { issues: ['offer spec must be a JSON object'] };

  const issues: string[] = [];
  const issuer = isRecord(parsed.issuer) ? parsed.issuer : undefined;
  const recipient = isRecord(parsed.recipient) ? parsed.recipient : undefined;

  if (!issuer) issues.push('issuer is required: { "tenantKey": "…" } or { "providerCode": { "type": "scac", "code": "…" } }');
  else {
    const providerCode = isRecord(issuer.providerCode) ? issuer.providerCode : undefined;
    if (!nonEmptyString(issuer.tenantKey) && !providerCode) {
      issues.push('issuer needs either tenantKey or providerCode { type, code }');
    }
    if (providerCode && (!nonEmptyString(providerCode.type) || !nonEmptyString(providerCode.code))) {
      issues.push('issuer.providerCode needs a non-empty type and code (e.g. scac / HLCU)');
    }
  }
  if (!recipient || !nonEmptyString(recipient.tenantKey)) {
    issues.push('recipient.tenantKey is required — the party this quote was offered to');
  }
  if (
    issuer && recipient &&
    nonEmptyString(issuer.tenantKey) && nonEmptyString(recipient.tenantKey) &&
    issuer.tenantKey === recipient.tenantKey
  ) {
    issues.push('issuer and recipient must be different tenants');
  }

  const services = Array.isArray(parsed.services) ? parsed.services : undefined;
  if (!services || services.length === 0) issues.push('services must be a non-empty array');
  const rowIds = new Set<string>();
  for (const [index, raw] of (services ?? []).entries()) {
    const at = `services[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${at} must be an object`);
      continue;
    }
    if (!nonEmptyString(raw.rowId)) issues.push(`${at}.rowId is required (your own local row identifier)`);
    else if (rowIds.has(raw.rowId)) issues.push(`${at}.rowId is not unique: ${raw.rowId}`);
    else rowIds.add(raw.rowId);
    if (!nonEmptyString(raw.serviceKey)) issues.push(`${at}.serviceKey is required`);

    for (const [locationIndex, location] of (Array.isArray(raw.locations) ? raw.locations : []).entries()) {
      const locationAt = `${at}.locations[${locationIndex}]`;
      if (!isRecord(location)) {
        issues.push(`${locationAt} must be an object`);
        continue;
      }
      if (!nonEmptyString(location.code)) issues.push(`${locationAt}.code is required`);
      if (!nonEmptyString(location.role)) issues.push(`${locationAt}.role is required`);
      if (location.sequence !== undefined && !Number.isInteger(location.sequence)) {
        issues.push(`${locationAt}.sequence must be an integer`);
      }
    }
    if (raw.locations !== undefined && !Array.isArray(raw.locations)) issues.push(`${at}.locations must be an array`);

    for (const [timeframeIndex, timeframe] of (Array.isArray(raw.timeframes) ? raw.timeframes : []).entries()) {
      const timeframeAt = `${at}.timeframes[${timeframeIndex}]`;
      if (!isRecord(timeframe)) {
        issues.push(`${timeframeAt} must be an object`);
        continue;
      }
      if (!nonEmptyString(timeframe.kind)) issues.push(`${timeframeAt}.kind is required`);
      for (const bound of ['dateFrom', 'dateTo'] as const) {
        if (timeframe[bound] !== undefined && !isIsoWireDate(timeframe[bound])) {
          issues.push(`${timeframeAt}.${bound} must be an ISO date string (2026-07-01) or date-time`);
        }
      }
      if (timeframe.dateFrom === undefined && timeframe.dateTo === undefined) {
        issues.push(`${timeframeAt} needs dateFrom, dateTo, or both`);
      }
    }
    if (raw.timeframes !== undefined && !Array.isArray(raw.timeframes)) issues.push(`${at}.timeframes must be an array`);

    if (raw.subtypes !== undefined) {
      if (!Array.isArray(raw.subtypes)) issues.push(`${at}.subtypes must be an array`);
      else if (raw.subtypes.some((subtype) => !nonEmptyString(subtype))) {
        issues.push(`${at}.subtypes entries must be non-empty strings`);
      }
    }

    for (const [chargeIndex, charge] of (Array.isArray(raw.charges) ? raw.charges : []).entries()) {
      const chargeAt = `${at}.charges[${chargeIndex}]`;
      if (!isRecord(charge)) {
        issues.push(`${chargeAt} must be an object`);
        continue;
      }
      if (!nonEmptyString(charge.chargeKey)) issues.push(`${chargeAt}.chargeKey is required`);
      // Zero is a real quoted value ("included"); a negative one is not a price.
      if (typeof charge.amount !== 'number' || !Number.isFinite(charge.amount) || charge.amount < 0) {
        issues.push(
          `${chargeAt}.amount must be a number, zero or more — a "% of another line" is a COMPUTED amount, plus meta`,
        );
      }
      if (!nonEmptyString(charge.currency) || !ISO_CURRENCIES.has(charge.currency)) {
        issues.push(`${chargeAt}.currency must be an ISO 4217 code (EUR, USD)`);
      }
    }
    if (raw.charges !== undefined && !Array.isArray(raw.charges)) issues.push(`${at}.charges must be an array`);
  }

  return issues.length ? { issues } : { spec: parsed as unknown as OfferSpec, issues: [] };
}

// ---------------------------------------------------------------------------
// Heroes catalogs — closed vocabularies, always fetched, never hard-coded
// ---------------------------------------------------------------------------

interface Catalogs {
  serviceKeys: Set<string>;
  locationRoles: Set<string>;
  timeframeKinds: Set<string>;
  assetSubtypes: Set<string>;
}

function codesOf(rows: unknown, ...fields: string[]): string[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (!isRecord(row)) return '';
      for (const field of fields) {
        if (nonEmptyString(row[field])) return (row[field] as string).trim();
      }
      return '';
    })
    .filter((value) => value !== '');
}

async function fetchCatalogs(config: Config, apiKey: string): Promise<Catalogs> {
  const [serviceData, roleData, kindData, assetTypeData] = await Promise.all([
    api<{ services?: unknown }>(config, { method: 'GET', path: '/catalog/services', apiKey }),
    api<{ location_roles?: unknown }>(config, { method: 'GET', path: '/catalog/location-roles', apiKey }),
    api<{ timeframe_kinds?: unknown }>(config, { method: 'GET', path: '/catalog/timeframe-kinds', apiKey }),
    api<{ asset_types?: unknown }>(config, { method: 'GET', path: '/catalog/asset-types', apiKey }),
  ]);

  const serviceKeys = new Set(
    codesOf(
      Array.isArray(serviceData) ? serviceData : serviceData?.services,
      'serviceKey',
      'key',
    ),
  );
  const locationRoles = new Set(codesOf(roleData?.location_roles, 'code'));
  const timeframeKinds = new Set(codesOf(kindData?.timeframe_kinds, 'code'));
  const assetTypes = codesOf(assetTypeData?.asset_types, 'code');

  const subtypeResponses = await Promise.all(
    assetTypes.map((assetType) =>
      api<{ asset_subtypes?: unknown }>(config, {
        method: 'GET',
        path: '/catalog/asset-subtypes',
        apiKey,
        query: { asset_type: assetType },
      }),
    ),
  );
  const assetSubtypes = new Set(
    subtypeResponses.flatMap((response) => codesOf(response?.asset_subtypes, 'subtype', 'code')),
  );

  if (serviceKeys.size === 0) throw new Error('Heroes returned no service keys');
  if (locationRoles.size === 0) throw new Error('GET /catalog/location-roles returned no roles');
  if (timeframeKinds.size === 0) throw new Error('GET /catalog/timeframe-kinds returned no kinds');
  return { serviceKeys, locationRoles, timeframeKinds, assetSubtypes };
}

function validateAgainstCatalogs(spec: OfferSpec, catalogs: Catalogs): string[] {
  const issues: string[] = [];
  const sorted = (values: Set<string>) => [...values].sort().join(', ');
  for (const [index, service] of spec.services.entries()) {
    const at = `services[${index}]`;
    if (!catalogs.serviceKeys.has(service.serviceKey)) {
      issues.push(`${at}.serviceKey "${service.serviceKey}" is not in GET /catalog/services`);
    }
    for (const [locationIndex, location] of (service.locations ?? []).entries()) {
      if (!catalogs.locationRoles.has(location.role)) {
        issues.push(
          `${at}.locations[${locationIndex}].role "${location.role}" is not in ` +
            `GET /catalog/location-roles (${sorted(catalogs.locationRoles)})`,
        );
      }
    }
    for (const [timeframeIndex, timeframe] of (service.timeframes ?? []).entries()) {
      if (!catalogs.timeframeKinds.has(timeframe.kind)) {
        issues.push(
          `${at}.timeframes[${timeframeIndex}].kind "${timeframe.kind}" is not in ` +
            `GET /catalog/timeframe-kinds (${sorted(catalogs.timeframeKinds)})`,
        );
      }
    }
    for (const subtype of service.subtypes ?? []) {
      if (!catalogs.assetSubtypes.has(subtype)) {
        issues.push(
          `${at}.subtypes "${subtype}" is not a Heroes asset subtype — map the carrier's label ` +
            `(20'STD → 20DC, 40'HC → 40HC) against GET /catalog/asset-subtypes`,
        );
      }
    }
  }
  return issues;
}

async function validateLocodes(config: Config, apiKey: string, spec: OfferSpec): Promise<string[]> {
  const codes = [
    ...new Set(spec.services.flatMap((service) => (service.locations ?? []).map((l) => l.code))),
  ];
  const issues: string[] = [];
  for (const code of codes) {
    try {
      await api(config, { method: 'GET', path: `/locodes/${encodeURIComponent(code)}`, apiKey });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        issues.push(`unknown UN/LOCODE "${code}" — resolve it with GET /locodes?search=`);
      } else throw error;
    }
  }
  return issues;
}

/**
 * Exact tenant-key confirmation for any authenticated key. `GET /tenants` is an
 * admin list and 403s here; `/tenants/discover` is fuzzy, so only an exact
 * tenantKey hit counts.
 */
async function tenantKeyExists(config: Config, apiKey: string, tenantKey: string): Promise<boolean> {
  const data = await api<unknown>(config, {
    method: 'GET',
    path: '/tenants/discover',
    apiKey,
    query: { q: tenantKey, limit: '50' },
  });
  const rows = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.tenants) ? data.tenants : [];
  return rows.some((row) => isRecord(row) && row.tenantKey === tenantKey);
}

// ---------------------------------------------------------------------------
// Wire bodies
// ---------------------------------------------------------------------------

interface ChargeRow {
  serviceRowId: string;
  heroesServiceId: string;
  chargeKey: string;
  amount: number;
  currency: string;
  meta?: unknown;
}

export function serviceCreateBody(
  spec: OfferSpec,
  service: SpecService,
  journeyId: string,
  issuerTenantKey: string,
): Record<string, unknown> {
  return {
    journeyId,
    serviceKey: service.serviceKey,
    // The OFFER relationship, stored as itself. Never issuer→assignee.
    participantTenantKeys: {
      issuer: issuerTenantKey,
      recipient: spec.recipient.tenantKey,
    },
    ...(service.locations?.length
      ? {
          locations: service.locations.map((location) => ({
            code: location.code,
            role: location.role,
            ...(location.sequence !== undefined ? { sequence: location.sequence } : {}),
          })),
        }
      : {}),
    ...(service.timeframes?.length
      ? {
          timeframes: service.timeframes.map((timeframe) => ({
            kind: timeframe.kind,
            // ISO strings on the wire — Heroes converts to Date in the handler.
            ...(timeframe.dateFrom !== undefined ? { dateFrom: timeframe.dateFrom } : {}),
            ...(timeframe.dateTo !== undefined ? { dateTo: timeframe.dateTo } : {}),
          })),
        }
      : {}),
    ...(service.subtypes?.length ? { subtypes: service.subtypes } : {}),
  };
}

export function offerChargesPayload(
  spec: OfferSpec,
  journeyId: string,
  serviceIdByRowId: Record<string, string>,
): { kind: 'offer_charges'; schemaVersion: 2; journeyId: string; charges: ChargeRow[] } | undefined {
  const charges: ChargeRow[] = [];
  for (const service of spec.services) {
    for (const charge of service.charges ?? []) {
      charges.push({
        serviceRowId: service.rowId,
        heroesServiceId: serviceIdByRowId[service.rowId],
        chargeKey: charge.chargeKey,
        amount: charge.amount,
        currency: charge.currency,
        ...(charge.meta !== undefined ? { meta: charge.meta } : {}),
      });
    }
  }
  if (charges.length === 0) return undefined;
  return { kind: 'offer_charges', schemaVersion: 2, journeyId, charges };
}

export function advanceBody(
  spec: OfferSpec,
  journeyId: string,
  issuerTenantKey: string,
  serviceIdByRowId: Record<string, string>,
): Record<string, unknown> {
  const payload = offerChargesPayload(spec, journeyId, serviceIdByRowId);
  return {
    strategyKey: 'DIRECT_QUOTE',
    stepKey: 'QUOTED',
    // The issuer is the counterparty on the other side of this quote. `role` is
    // deliberately omitted: it is the ASSIGNMENT-side hint, and omitting it says
    // the recipient is recording a quote it was given.
    targetTenantKey: issuerTenantKey,
    name: spec.eventName ?? (spec.reference ? `Quotation ${spec.reference}` : 'Quotation'),
    ...(payload
      ? {
          payload: JSON.stringify(payload),
          payloadMeta: { contentType: 'application/json', filename: 'offer-charges.json', ext: 'json' },
        }
      : {}),
  };
}

/** The issuer and recipient rows Heroes actually wrote, read off the create response. */
function relationshipRoles(service: unknown): { issuer?: string; recipient?: string } {
  const participants =
    isRecord(service) && Array.isArray(service.participants) ? service.participants : [];
  const found: { issuer?: string; recipient?: string } = {};
  for (const participant of participants) {
    if (!isRecord(participant)) continue;
    if (participant.role === 'issuer' && nonEmptyString(participant.tenantKey)) {
      found.issuer = participant.tenantKey;
    }
    if (participant.role === 'recipient' && nonEmptyString(participant.tenantKey)) {
      found.recipient = participant.tenantKey;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function compose(config: Config): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const specPath = positional[0];
  const attachFolder = flagString(flags, 'attach');
  const existingJourneyId = flagString(flags, 'journey-id');
  const dryRun = flags['dry-run'] === true;
  const jsonOnly = flags.json === true;

  if ('journey-id' in flags && !existingJourneyId?.trim()) {
    throw new Error('--journey-id requires a value');
  }
  if ('attach' in flags && !attachFolder?.trim()) {
    throw new Error('--attach requires a payload folder');
  }
  if (!specPath) {
    throw new Error(
      'Usage: npx tsx compose-offer.ts <offer-spec.json> [--attach <payload-folder>] ' +
        '[--journey-id <id>] [--dry-run] [--json]',
    );
  }

  const say = (label: string, value: unknown) => {
    if (!jsonOnly) kv(label, value);
  };
  const section = (text: string) => {
    if (!jsonOnly) heading(text);
  };

  const parsed = readSpec(specPath);
  if (!parsed.spec) refuse(4, 'invalid_spec', { issues: parsed.issues });
  const spec = parsed.spec as OfferSpec;

  const apiKey = requireApiKey(config);
  // Read the staged document up front: a missing or ambiguous payload folder must
  // fail before anything is written, not after the offer is already recorded.
  const payload = attachFolder ? readPayloadFolder(attachFolder) : undefined;

  section('Reading Heroes catalogs');
  let catalogs!: Catalogs;
  try {
    catalogs = await fetchCatalogs(config, apiKey);
  } catch (error) {
    refuse(2, 'catalog_unavailable', {
      detail: error instanceof Error ? error.message : String(error),
      needed: [
        'GET /catalog/services',
        'GET /catalog/location-roles',
        'GET /catalog/timeframe-kinds',
        'GET /catalog/asset-types',
        'GET /catalog/asset-subtypes',
      ],
    });
  }
  say('location roles', [...catalogs.locationRoles].sort().join(', '));
  say('timeframe kinds', [...catalogs.timeframeKinds].sort().join(', '));

  // An empty subtype catalog cannot approve a subtype; it means the read did not
  // answer. Silently treating every user-supplied subtype as valid would break the
  // promise that every controlled value is resolved before the first write.
  if (spec.services.some((service) => service.subtypes?.length) && catalogs.assetSubtypes.size === 0) {
    refuse(2, 'catalog_unavailable', {
      detail:
        'The spec names cargo subtypes, but GET /catalog/asset-subtypes returned none, so no subtype ' +
        'can be checked. Retry the read; do not file the offer with unverified equipment.',
      needed: ['GET /catalog/asset-types', 'GET /catalog/asset-subtypes'],
    });
  }

  const catalogIssues = [
    ...validateAgainstCatalogs(spec, catalogs),
    ...(await validateLocodes(config, apiKey, spec)),
  ];
  if (catalogIssues.length) refuse(4, 'invalid_spec', { issues: catalogIssues });

  section('Resolving offer parties');
  let issuerTenantKey = spec.issuer.tenantKey;
  if (!issuerTenantKey && spec.issuer.providerCode) {
    const { type, code } = spec.issuer.providerCode;
    try {
      const tenant = await api<{ tenantKey?: string }>(config, {
        method: 'GET',
        path: `/tenants/by-provider-code/${encodeURIComponent(type)}/${encodeURIComponent(code)}`,
        apiKey,
      });
      issuerTenantKey = tenant?.tenantKey;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
    if (!issuerTenantKey) {
      refuse(5, 'issuer_not_in_network', {
        providerCode: spec.issuer.providerCode,
        detail:
          'No Heroes tenant carries this provider code. The issuing party must be enrolled before its ' +
          'quote can name it; do not substitute another tenant, and do not remap the role.',
      });
    }
  } else if (issuerTenantKey && !(await tenantKeyExists(config, apiKey, issuerTenantKey))) {
    refuse(5, 'issuer_not_in_network', {
      issuerTenantKey,
      detail: 'No Heroes tenant has this tenantKey. Enrol the issuing party rather than renaming it.',
    });
  }
  // Re-checked after resolution, not only on the literal spec: a provider code can
  // resolve to the recipient's own tenant, and an offer whose two parties collapse
  // into one is not an offer.
  if (issuerTenantKey === spec.recipient.tenantKey) {
    refuse(4, 'issuer_and_recipient_are_the_same_tenant', {
      issuerTenantKey,
      recipientTenantKey: spec.recipient.tenantKey,
      ...(spec.issuer.providerCode ? { resolvedFrom: spec.issuer.providerCode } : {}),
    });
  }
  if (!(await tenantKeyExists(config, apiKey, spec.recipient.tenantKey))) {
    refuse(4, 'unknown_recipient_tenant_key', { recipientTenantKey: spec.recipient.tenantKey });
  }
  say('issuer', issuerTenantKey);
  say('recipient', spec.recipient.tenantKey);

  if (dryRun) {
    const previewJourneyId = existingJourneyId ?? '<journey-id>';
    const serviceIdByRowId = Object.fromEntries(
      spec.services.map((service) => [service.rowId, `<service-id:${service.rowId}>`]),
    );
    console.log(
      JSON.stringify(
        {
          status: 'dry-run',
          journeyCreate: existingJourneyId ? null : { method: 'POST', path: '/journeys', body: { type: 'OFFER' } },
          serviceCreates: spec.services.map((service) => ({
            method: 'POST',
            path: '/services',
            body: serviceCreateBody(spec, service, previewJourneyId, issuerTenantKey!),
          })),
          advance: {
            method: 'POST',
            path: `/journeys/${previewJourneyId}/strategy/advance`,
            body: advanceBody(spec, previewJourneyId, issuerTenantKey!, serviceIdByRowId),
          },
          attachment: payload
            ? { method: 'POST', path: '/events/attachments', filename: payload.filename }
            : null,
        },
        null,
        2,
      ),
    );
    return;
  }

  // -------------------------------------------------------------------------
  // Writes.
  //
  // A write that the server DEFINITIVELY rejected (a 4xx: it validated the body and
  // said no) left nothing behind, so this run releases what it created — services
  // first, then the journey it minted. A write whose outcome is UNKNOWN (a transport
  // error, a 5xx) is never compensated: the transaction may have committed before the
  // response was lost, and deleting on that guess would erase a quote that is already
  // filed. Those cases keep their ids and come back for reconciliation.
  // -------------------------------------------------------------------------

  /** True when the server answered, validated the request, and refused it: nothing was written. */
  const definitivelyRejected = (error: unknown): boolean =>
    error instanceof ApiError && error.status >= 400 && error.status < 500;

  let journeyId = existingJourneyId;
  const createdJourney = !journeyId;
  if (journeyId) {
    section('Checking the resume journey');
    // The batch advance moves EVERY service on this journey, not only the ones created
    // here. A typo, or a journey that already carries work, would drag unrelated
    // services into this quote — so the resume target must be an owned, empty OFFER.
    let journey: { id?: string; type?: string } | undefined;
    try {
      journey = await api<{ id?: string; type?: string }>(config, {
        method: 'GET',
        path: `/journeys/${encodeURIComponent(journeyId)}`,
        apiKey,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        refuse(4, 'resume_journey_not_found', {
          journeyId,
          detail:
            'GET /journeys is owner-scoped: this id does not exist, or it is not yours. Do not create ' +
            'services on a journey you cannot read.',
        });
      }
      throw error;
    }
    if (journey?.type !== 'OFFER') {
      refuse(4, 'resume_journey_is_not_an_offer', {
        journeyId,
        type: journey?.type ?? null,
        detail:
          'A held quote is filed on an OFFER journey. Filing it on a SHIPMENT would advance that ' +
          "shipment's services with this quote's charges.",
      });
    }
    const existingRaw = await api<unknown>(config, {
      method: 'GET',
      path: `/journeys/${encodeURIComponent(journeyId)}/services`,
      apiKey,
    });
    const existing = Array.isArray(existingRaw)
      ? existingRaw
      : isRecord(existingRaw) && Array.isArray(existingRaw.services)
        ? existingRaw.services
        : [];
    if (existing.length > 0) {
      refuse(4, 'resume_journey_is_not_empty', {
        journeyId,
        existingServices: existing.length,
        detail:
          '--journey-id resumes the one recovery case this helper supports: the journey was minted, ' +
          'and service creation had not succeeded. This journey already carries services, and the ' +
          'advance would move them too. Reconcile it by hand, or file the quote on a new journey.',
      });
    }
  } else {
    section('Creating offer journey');
    try {
      const journey = await api<{ id: string }>(config, {
        method: 'POST',
        path: '/journeys',
        apiKey,
        body: { type: 'OFFER' },
      });
      journeyId = journey.id;
    } catch (error) {
      // A rejected body created nothing. Anything else — a timeout, a 5xx — may
      // or may not have minted a journey, and retrying would mint a second one.
      if (definitivelyRejected(error)) {
        refuse(4, 'journey_create_rejected', { detail: (error as ApiError).message });
      }
      refuse(7, 'journey_create_unconfirmed', {
        detail: error instanceof Error ? error.message : String(error),
        nextStep:
          'Do NOT rerun this command: a retry mints a second offer. Find whether the journey exists ' +
          '(POST /offers/search, or the Heroes UI). If it does, resume with --journey-id <id>.',
      });
    }
  }
  say('journeyId', journeyId);

  const createdServiceIds: string[] = [];
  const release = async (): Promise<{ releasedServices: string[]; releasedJourney: string | null; failures: string[] }> => {
    const failures: string[] = [];
    const releasedServices: string[] = [];
    // Services first: a journey cannot be released while its services still hang off it.
    for (const serviceId of createdServiceIds) {
      try {
        await api(config, { method: 'DELETE', path: `/services/${serviceId}`, apiKey });
        releasedServices.push(serviceId);
      } catch (error) {
        failures.push(`service ${serviceId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let releasedJourney: string | null = null;
    // Only a journey this run minted, and only while it carries no strategy
    // instance — a recorded quote is never deleted.
    if (createdJourney && failures.length === 0) {
      try {
        await api(config, { method: 'DELETE', path: `/journeys/${journeyId}`, apiKey });
        releasedJourney = journeyId!;
      } catch (error) {
        failures.push(`journey ${journeyId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { releasedServices, releasedJourney, failures };
  };

  /**
   * Release after a definitive rejection, and report it. `code` is the refusal's own
   * meaning when nothing is left behind; if the release itself could not finish, that
   * becomes exit `10` instead — state may remain, and a human has to look.
   */
  const releaseAndRefuse: (
    code: number,
    reason: string,
    detail: Record<string, unknown>,
  ) => Promise<never> = async (code, reason, detail) => {
    const released = await release();
    refuse(released.failures.length ? 10 : code, reason, {
      ...detail,
      ...released,
      journeyId,
      ...(released.failures.length
        ? { nextStep: 'Release did not finish. Reconcile the ids above by hand before refiling.' }
        : {}),
    });
  };

  /** Keep everything, name it, and hand it to a human: the outcome is genuinely unknown. */
  const reconcile: (reason: string, detail: Record<string, unknown>) => never = (reason, detail) =>
    refuse(10, reason, {
      ...detail,
      journeyId,
      serviceIds: createdServiceIds,
      nextStep:
        'Nothing was deleted: this write may have committed before its response was lost, and ' +
        'compensating on a guess would erase a filed quote. Check the journey (POST /offers/search, ' +
        'or the Heroes UI) and finish or release it by hand. Do not rerun this command.',
    });

  section('Creating offer services');
  const serviceIdByRowId: Record<string, string> = {};
  for (const service of spec.services) {
    let created!: { id: string };
    try {
      created = await api<{ id: string }>(config, {
        method: 'POST',
        path: '/services',
        apiKey,
        body: serviceCreateBody(spec, service, journeyId!, issuerTenantKey!),
      });
    } catch (error) {
      const detail = { rowId: service.rowId, detail: error instanceof Error ? error.message : String(error) };
      if (!definitivelyRejected(error)) {
        // The service may exist under an id this run never saw. Releasing the rest
        // would then strand it on a half-built offer.
        reconcile('service_create_unconfirmed', detail);
      }
      await releaseAndRefuse(9, 'service_create_rejected', detail);
    }

    // Refuse rather than invent: if Heroes did not persist the relationship, the
    // answer is a Heroes write, not an assignment-role stand-in. The service exists
    // and carries no strategy, so this one IS safe to release.
    const roles = relationshipRoles(created!);
    if (roles.issuer !== issuerTenantKey || roles.recipient !== spec.recipient.tenantKey) {
      createdServiceIds.push(created!.id);
      await releaseAndRefuse(6, 'issuer_recipient_write_unavailable', {
        rowId: service.rowId,
        expected: { issuer: issuerTenantKey, recipient: spec.recipient.tenantKey },
        persisted: roles,
        detail:
          'POST /services did not store the OFFER relationship. Do not remap issuer→assignee or ' +
          'recipient→assigner; that records a relationship nobody agreed to. This needs a Heroes API fix.',
      });
    }

    createdServiceIds.push(created!.id);
    serviceIdByRowId[service.rowId] = created!.id;
    say(service.rowId, `${created!.id} (${service.serviceKey})`);
  }

  section('Recording the quote (DIRECT_QUOTE / QUOTED)');
  const body = advanceBody(spec, journeyId!, issuerTenantKey!, serviceIdByRowId);
  let advanced!: { count?: number; advanced?: { serviceId: string; eventId: number }[] };
  try {
    advanced = await api(config, {
      method: 'POST',
      path: `/journeys/${journeyId}/strategy/advance`,
      apiKey,
      body,
    });
  } catch (error) {
    const detail = { detail: error instanceof Error ? error.message : String(error) };
    // The advance is transactional, but transactional is not the same as observed. A
    // 4xx means it was refused before committing, so this is still a pre-advance
    // attempt and it is released whole. A lost response or a 5xx may sit on either
    // side of the commit, and deleting there would erase a quote that IS filed.
    if (!definitivelyRejected(error)) {
      reconcile('advance_unconfirmed', detail);
    }
    await releaseAndRefuse(9, 'advance_rejected', detail);
  }
  // Heroes records ONE event for the whole batch, so every `advanced[]` row carries
  // the same id — that is what the document attaches to. Reported as a set, so a
  // future change to that guarantee is visible rather than silently half-attached.
  const advancedRows = advanced!.advanced ?? [];
  const eventIds = [...new Set(advancedRows.map((row) => row.eventId))];
  const eventId = eventIds[0];
  say('services advanced', advancedRows.length);
  say('eventId', eventIds.join(', ') || '—');
  say('charges', (body.payload ? JSON.parse(body.payload as string).charges.length : 0));
  if (!body.payload && !jsonOnly) {
    console.log('\n  No charges in the spec — the offer carries no offer_charges payload.');
  }

  if (payload) {
    section('Attaching the vendor document');
    if (eventId === undefined) {
      throw new Refusal(8, {
        status: 'recorded',
        reason: 'attachment_failed',
        detail: 'The advance returned no eventId, so there is nothing to attach to.',
        journeyId,
        serviceIds: createdServiceIds,
      });
    }
    try {
      await uploadAttachment(config, apiKey, eventId, payload);
      say('attachment', payload.filename);
    } catch (error) {
      // The quote IS recorded. Never release here; re-attach instead.
      throw new Refusal(8, {
        status: 'recorded',
        reason: 'attachment_failed',
        detail: error instanceof Error ? error.message : String(error),
        journeyId,
        serviceIds: createdServiceIds,
        eventId,
        nextStep: `npx tsx upload-attachment.ts ${eventId} ${attachFolder}`,
      });
    }
  }

  const result = {
    status: 'composed' as const,
    journeyId,
    issuerTenantKey,
    recipientTenantKey: spec.recipient.tenantKey,
    services: spec.services.map((service) => ({
      rowId: service.rowId,
      serviceId: serviceIdByRowId[service.rowId],
      serviceKey: service.serviceKey,
    })),
    eventId: eventId ?? null,
    eventIds,
    attachmentEventId: payload ? (eventId ?? null) : null,
    attachment: payload?.filename ?? null,
  };
  section('Done');
  say('journeyId', journeyId);
  say('eventId', eventIds.join(', ') || '—');
  if (!jsonOnly) {
    // Kept free of braces so the JSON result below is the only parseable object on stdout.
    console.log(
      '\n  Prove findability with POST /offers/search — a locodes facet on the load port ' +
        `with role port_of_loading, or a participants facet on tenantKey ${issuerTenantKey} ` +
        'with role issuer.\n',
    );
  }
  console.log(JSON.stringify(result, null, 2));
}

run(async (config) => {
  try {
    await compose(config);
  } catch (error) {
    // A refusal is a result, not a crash: print it, set the exit code, and let the
    // process wind down on its own.
    if (error instanceof Refusal) {
      console.log(JSON.stringify(error.output, null, 2));
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
});
