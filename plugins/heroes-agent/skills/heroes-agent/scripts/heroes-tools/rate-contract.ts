import { createHash } from 'node:crypto';
import { api, csvToObjects, objectsToCsv, type Config } from './lib';

export const RATE_CONTRACT_VERSION = '1.0' as const;

export interface HeroesRateCatalog {
  schemaVersion: typeof RATE_CONTRACT_VERSION;
  fetchedAt: string;
  responseHash: string;
  openApiVersion: string;
  services: { serviceKey: string }[];
  assetTypes: { code: string }[];
  assetSubtypes: { assetType: string; subtype: string }[];
  locationRoles: string[];
  timeframeKinds: string[];
  participantRoles: string[];
  strategies: { strategyKey: string; steps: string[] }[];
}

export type LocationRole = string;

export interface RateCharge {
  chargeKey: string;
  amount?: string;
  currency: string;
  basis: string;
  minimum?: string;
  maximum?: string;
  tiers?: { upTo: string | null; amount: string }[];
}

export interface RateRule {
  id: string;
  serviceKey: string;
  locodes: { code: string; role: LocationRole }[];
  timeframes: { from: string; to: string }[];
  assetTypes: { type: string; subtypes: string[] }[];
  participants: { tenantKey: string; role: string }[];
  strategy: { strategyKey: string; currentStep: string } | null;
  charges: RateCharge[];
  conditions: string[];
}

export interface RateCard {
  id: string;
  journeyType: 'OFFER';
  rules: RateRule[];
  sourceEvidence: { sourceFile: string; sourceRef: string; sourceHash: string }[];
  approval: { status: 'draft' | 'approved'; approvedBy: string; approvedAt: string; contentHash?: string };
  catalogReference: { responseHash: string; fetchedAt: string };
}

export interface RateCatalog {
  schemaVersion: typeof RATE_CONTRACT_VERSION;
  rateCards: RateCard[];
}

export interface RateDiscoveryQuery {
  serviceKey: string;
  locodes: { code: string; role: LocationRole }[];
  timeframes?: { from?: string; to?: string }[];
  assetTypes?: { type: string; subtypes: string[] }[];
  participants?: { tenantKey: string; role: string }[];
  strategy?: { strategyKey: string; currentStep?: string };
}

export interface RateCandidate {
  cardId: string;
  rule: RateRule;
  sourceEvidence: RateCard['sourceEvidence'];
  missingFacts: string[];
  /** Business blockers that make stored evidence unsafe for automatic use. */
  ineligibleReasons: string[];
}

export interface RateDiscovery {
  status: 'matched' | 'none' | 'incomplete' | 'ambiguous' | 'invalid';
  match: boolean;
  reason: string;
  query: RateDiscoveryQuery;
  rate?: RateCandidate;
  candidates: RateCandidate[];
}

export const RATE_CSV_COLUMNS = [
  'cardId', 'ruleId', 'serviceKey', 'origin', 'destination', 'locationCode', 'locationRole',
  'assetType', 'assetSubtype', 'validFrom', 'validTo', 'chargeKey', 'amount', 'currency',
  'basis', 'minimum', 'maximum', 'tiersJson', 'sourceRef', 'approvalStatus', 'approvedBy', 'approvedAt', 'condition',
  'locodesJson', 'assetTypesJson', 'participantsJson', 'strategyJson', 'conditionsJson', 'sourceEvidenceJson',
  'timeframesJson', 'cardContentHash',
] as const;

function asRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  for (const key of ['services', 'catalog', 'items']) {
    if (Array.isArray(record[key])) return asRecords(record[key]);
  }
  return [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function catalogValues(catalog: HeroesRateCatalog) {
  return {
    openApiVersion: catalog.openApiVersion,
    services: catalog.services,
    assetTypes: catalog.assetTypes,
    assetSubtypes: catalog.assetSubtypes,
    locationRoles: catalog.locationRoles,
    timeframeKinds: catalog.timeframeKinds,
    participantRoles: catalog.participantRoles,
    strategies: catalog.strategies,
  };
}

export function computeHeroesCatalogHash(catalog: HeroesRateCatalog): string {
  return createHash('sha256').update(stableJson(catalogValues(catalog))).digest('hex');
}

function computeRateCardHash(card: RateCard): string {
  const approvedContent = {
    id: card.id,
    journeyType: card.journeyType,
    rules: card.rules,
    sourceEvidence: card.sourceEvidence,
    approval: {
      status: card.approval.status,
      approvedBy: card.approval.approvedBy,
      approvedAt: card.approval.approvedAt,
    },
    catalogReference: card.catalogReference,
  };
  return createHash('sha256').update(stableJson(approvedContent)).digest('hex');
}

export function approveRateCard(card: RateCard, approvedBy: string, approvedAt: string): void {
  card.approval = { status: 'approved', approvedBy, approvedAt };
  card.approval.contentHash = computeRateCardHash(card);
}

export function validateRateCardApprovals(rateCatalog: RateCatalog): string[] {
  const issues: string[] = [];
  for (const card of rateCatalog.rateCards ?? []) {
    if (card.approval?.status === 'approved' &&
      (!card.approval.contentHash || card.approval.contentHash !== computeRateCardHash(card))) {
      issues.push(`card ${card.id || '(missing id)'}: approved content hash does not match`);
    }
  }
  return issues;
}

export async function fetchHeroesRateCatalog(
  config: Config,
  apiKey: string,
  now = new Date().toISOString(),
): Promise<HeroesRateCatalog> {
  const apiRoot = config.apiUrl.endsWith('/api') ? config.apiUrl.slice(0, -4) : config.apiUrl;
  const [openApiResponse, serviceData, assetTypeData, strategyData, locationRoleData, timeframeKindData] =
    await Promise.all([
      fetch(`${apiRoot}/openapi`),
      api<unknown>(config, {
        method: 'GET', path: '/catalog/services', apiKey,
      }),
      api<{ asset_types?: unknown }>(config, {
        method: 'GET', path: '/catalog/asset-types', apiKey,
      }),
      api<{ templates?: unknown }>(config, {
        method: 'GET', path: '/strategies/templates', apiKey,
      }),
      // Location roles and timeframe kinds are closed Heroes vocabularies with their own
      // catalog reads. They used to be scraped out of the /openapi document, which only
      // ever exposed them as a side effect of how /offers/search happened to be published
      // — one schema change and the rate book silently lost its vocabulary.
      api<{ location_roles?: unknown }>(config, {
        method: 'GET', path: '/catalog/location-roles', apiKey,
      }),
      api<{ timeframe_kinds?: unknown }>(config, {
        method: 'GET', path: '/catalog/timeframe-kinds', apiKey,
      }),
    ]);
  if (!openApiResponse.ok) throw new Error(`Heroes OpenAPI returned ${openApiResponse.status}.`);
  const openApi = await openApiResponse.json() as Record<string, any>;
  const offerProperties = openApi?.paths?.['/api/offers/search']?.post?.requestBody
    ?.content?.['application/json']?.schema?.properties;
  // Participant roles have no catalog read of their own yet; they remain the one
  // vocabulary this snapshot still takes from the published spec.
  const participantRoles = [...(offerProperties?.participants?.items?.properties?.role?.enum ?? [])]
    .filter((role): role is string => typeof role === 'string').sort();
  const openApiVersion = text(openApi?.info?.version);
  const locationRoles = asRecords(locationRoleData?.location_roles)
    .map((row) => text(row.code)).filter(Boolean).sort();
  const timeframeKinds = asRecords(timeframeKindData?.timeframe_kinds)
    .map((row) => text(row.code)).filter(Boolean).sort();

  const services = asRecords(serviceData)
    .map((row) => ({ serviceKey: text(row.serviceKey ?? row.key) }))
    .filter((row) => row.serviceKey)
    .sort((a, b) => a.serviceKey.localeCompare(b.serviceKey));
  const assetTypes = asRecords(assetTypeData?.asset_types)
    .map((row) => ({ code: text(row.code) }))
    .filter((row) => row.code)
    .sort((a, b) => a.code.localeCompare(b.code));
  if (services.length === 0) throw new Error('Heroes returned no provider service keys.');
  if (assetTypes.length === 0) throw new Error('Heroes returned no asset types.');
  if (!openApiVersion || participantRoles.length === 0) {
    throw new Error('Heroes OpenAPI did not define required offer vocabulary.');
  }
  if (locationRoles.length === 0) {
    throw new Error('GET /catalog/location-roles returned no location roles.');
  }
  if (timeframeKinds.length === 0) {
    throw new Error('GET /catalog/timeframe-kinds returned no timeframe kinds.');
  }
  const strategies = asRecords(strategyData?.templates).map((row) => ({
    strategyKey: text(row.key),
    steps: asRecords(row.steps).map((step) => text(step.key)).filter(Boolean).sort(),
  })).filter((strategy) => strategy.strategyKey).sort((a, b) =>
    a.strategyKey.localeCompare(b.strategyKey),
  );

  const subtypeResponses = await Promise.all(assetTypes.map(async ({ code }) => ({
    code,
    data: await api<{ asset_subtypes?: unknown }>(config, {
      method: 'GET', path: '/catalog/asset-subtypes', apiKey, query: { asset_type: code },
    }),
  })));
  const assetSubtypes = subtypeResponses.flatMap(({ code, data }) =>
    asRecords(data?.asset_subtypes)
      .map((row) => ({ assetType: code, subtype: text(row.subtype) }))
      .filter((row) => row.subtype),
  ).sort((a, b) => `${a.assetType}:${a.subtype}`.localeCompare(`${b.assetType}:${b.subtype}`));

  const values = {
    openApiVersion, services, assetTypes, assetSubtypes, locationRoles, timeframeKinds,
    participantRoles, strategies,
  };
  const catalog = {
    schemaVersion: RATE_CONTRACT_VERSION,
    fetchedAt: now,
    responseHash: '',
    ...values,
  } satisfies HeroesRateCatalog;
  catalog.responseHash = computeHeroesCatalogHash(catalog);
  return catalog;
}

function required(row: Record<string, string>, key: string, source: string): string {
  const value = text(row[key]);
  if (!value) throw new Error(`${source}: missing ${key}`);
  return value;
}

function jsonValue<T>(raw: string | undefined, fallback: T, source: string, key: string): T {
  if (!text(raw)) return fallback;
  try {
    return JSON.parse(raw as string) as T;
  } catch {
    throw new Error(`${source}: ${key} must contain valid JSON`);
  }
}

function positiveDecimal(value: string, source: string, field = 'amount'): string {
  if (!isPositiveDecimal(value)) {
    throw new Error(`${source}: ${field} must be a positive decimal`);
  }
  return value;
}

function isPositiveDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number(value) > 0;
}

export const ISO_CURRENCIES = new Set([
  ...Intl.supportedValuesOf('currency'),
  'BOV', 'CHE', 'CHW', 'CLF', 'COU', 'MXV', 'USN', 'UYI', 'UYW',
  'XBA', 'XBB', 'XBC', 'XBD', 'XDR', 'XSU', 'XTS', 'XUA', 'XXX',
]);

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isIsoDateTime(value: string): boolean {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value);
}

function catalogIndex(catalog: HeroesRateCatalog) {
  return {
    serviceKeys: new Set(catalog.services.map((item) => item.serviceKey)),
    assetTypes: new Set(catalog.assetTypes.map((item) => item.code)),
    assetSubtypes: new Set(catalog.assetSubtypes.map((item) => `${item.assetType}\u0000${item.subtype}`)),
    locationRoles: new Set(catalog.locationRoles),
    participantRoles: new Set(catalog.participantRoles),
    strategies: new Map(catalog.strategies.map((item) => [item.strategyKey, new Set(item.steps)])),
  };
}

export function validateRateCatalog(
  rateCatalog: RateCatalog,
  heroesCatalog: HeroesRateCatalog,
): string[] {
  const issues: string[] = [];
  // A snapshot taken before timeframe kinds were part of the catalog is stale, not
  // corrupt, and the hash check below cannot tell the operator which it is. Name it
  // first, so the fix reads as "re-sync" rather than "your file is broken".
  if (!Array.isArray(heroesCatalog.timeframeKinds)) {
    issues.push(
      'Heroes catalog snapshot predates timeframe kinds; re-run sync-rate-catalog.ts, then ' +
        're-approve affected cards with ingest-rates.ts --approve-by <name>',
    );
    return issues;
  }
  if (heroesCatalog.schemaVersion !== RATE_CONTRACT_VERSION ||
      !isIsoDateTime(heroesCatalog.fetchedAt) ||
      computeHeroesCatalogHash(heroesCatalog) !== heroesCatalog.responseHash) {
    issues.push('Heroes catalog snapshot is invalid or its response hash does not match');
    return issues;
  }
  if (rateCatalog.schemaVersion !== RATE_CONTRACT_VERSION) {
    issues.push(`unsupported rate catalog version ${rateCatalog.schemaVersion}`);
    return issues;
  }
  issues.push(...validateRateCardApprovals(rateCatalog));
  const { serviceKeys, assetTypes, assetSubtypes, locationRoles, participantRoles, strategies } =
    catalogIndex(heroesCatalog);
  const cardIds = new Set<string>();
  for (const card of rateCatalog.rateCards) {
    const cardAt = `card ${card.id || '(missing id)'}`;
    if (!card.id) issues.push('card id is required');
    else if (cardIds.has(card.id)) issues.push(`duplicate card id ${card.id}`);
    cardIds.add(card.id);
    if (card.journeyType !== 'OFFER') issues.push(`${cardAt}: journeyType must be OFFER`);
    if (!isIsoDateTime(card.catalogReference?.fetchedAt)) {
      issues.push(`${cardAt}: catalog fetchedAt must be an ISO timestamp`);
    }
    if (!Array.isArray(card.sourceEvidence) || card.sourceEvidence.length === 0) {
      issues.push(`${cardAt}: source evidence is required`);
    }
    for (const [index, evidence] of (card.sourceEvidence ?? []).entries()) {
      if (!evidence.sourceFile) issues.push(`${cardAt}, evidence ${index + 1}: sourceFile is required`);
      if (!evidence.sourceRef) issues.push(`${cardAt}, evidence ${index + 1}: sourceRef is required`);
      if (!/^[a-f0-9]{64}$/.test(evidence.sourceHash)) {
        issues.push(`${cardAt}, evidence ${index + 1}: sourceHash must be a SHA-256 hash`);
      }
    }
    if (!card.approval || !['draft', 'approved'].includes(card.approval.status)) {
      issues.push(`${cardAt}: approval status must be draft or approved`);
    } else if (card.approval.status === 'approved') {
      if (!card.approval.approvedBy || !isIsoDateTime(card.approval.approvedAt)) {
        issues.push(`${cardAt}: approvedBy and an ISO approvedAt are required`);
      }
    }
    if (!Array.isArray(card.rules) || card.rules.length === 0) issues.push(`${cardAt}: at least one rate rule is required`);
    const ruleIds = new Set<string>();
    for (const rule of card.rules ?? []) {
      const ruleAt = `${cardAt}, rule ${rule.id || '(missing id)'}`;
      if (!rule.id) issues.push(`${cardAt}: rule id is required`);
      else if (ruleIds.has(rule.id)) issues.push(`${cardAt}: duplicate rule id ${rule.id}`);
      ruleIds.add(rule.id);
      if (!serviceKeys.has(rule.serviceKey)) issues.push(`${ruleAt}: unknown Heroes serviceKey ${rule.serviceKey}`);
      if (!Array.isArray(rule.locodes)) issues.push(`${ruleAt}: locations must be an array`);
      for (const location of rule.locodes ?? []) {
        if (!location.code) issues.push(`${ruleAt}: location code is required`);
        if (!locationRoles.has(location.role)) issues.push(`${ruleAt}: unknown Heroes location role ${location.role}`);
      }
      for (const asset of rule.assetTypes ?? []) {
        if (!assetTypes.has(asset.type)) issues.push(`${ruleAt}: unknown Heroes assetType ${asset.type}`);
        for (const subtype of asset.subtypes ?? []) {
          if (!assetSubtypes.has(`${asset.type}\u0000${subtype}`)) {
            issues.push(`${ruleAt}: unknown Heroes asset subtype ${asset.type}/${subtype}`);
          }
        }
      }
      for (const timeframe of rule.timeframes ?? []) {
        if ((timeframe.from && !isIsoDate(timeframe.from)) || (timeframe.to && !isIsoDate(timeframe.to))) {
          issues.push(`${ruleAt}: invalid timeframe date`);
        } else if (timeframe.from && timeframe.to && timeframe.from > timeframe.to) {
          issues.push(`${ruleAt}: timeframe from cannot exceed to`);
        }
      }
      for (const participant of rule.participants ?? []) {
        if (!participant.tenantKey) issues.push(`${ruleAt}: participant tenantKey is required`);
        if (!participantRoles.has(participant.role)) issues.push(`${ruleAt}: unknown Heroes participant role ${participant.role}`);
      }
      if (rule.strategy) {
        const steps = strategies.get(rule.strategy.strategyKey);
        if (!steps) issues.push(`${ruleAt}: unknown Heroes strategy ${rule.strategy.strategyKey}`);
        else if (!steps.has(rule.strategy.currentStep)) {
          issues.push(`${ruleAt}: unknown Heroes strategy step ${rule.strategy.strategyKey}/${rule.strategy.currentStep}`);
        }
      }
      if (!Array.isArray(rule.charges) || rule.charges.length === 0) issues.push(`${ruleAt}: at least one charge is required`);
      const chargeKeys = new Set<string>();
      for (const charge of rule.charges ?? []) {
        const chargeAt = `${ruleAt}, charge ${charge.chargeKey || '(missing key)'}`;
        if (!charge.chargeKey) issues.push(`${ruleAt}: chargeKey is required`);
        else if (chargeKeys.has(charge.chargeKey)) issues.push(`${ruleAt}: duplicate chargeKey ${charge.chargeKey}`);
        chargeKeys.add(charge.chargeKey);
        if (charge.amount && !isPositiveDecimal(charge.amount)) {
          issues.push(`${chargeAt}: amount must be a positive decimal`);
        }
        if (Boolean(charge.amount) === Boolean(charge.tiers?.length)) {
          issues.push(`${chargeAt}: exactly one of amount or tiers is required`);
        }
        for (const [name, value] of [['minimum', charge.minimum], ['maximum', charge.maximum]] as const) {
          if (value && !isPositiveDecimal(value)) {
            issues.push(`${chargeAt}: ${name} must be a positive decimal`);
          }
        }
        if (charge.minimum && charge.maximum && Number(charge.minimum) > Number(charge.maximum)) {
          issues.push(`${chargeAt}: minimum cannot exceed maximum`);
        }
        let previousLimit = 0;
        for (const [index, tier] of (charge.tiers ?? []).entries()) {
          if (!isPositiveDecimal(tier.amount)) {
            issues.push(`${chargeAt}: tier ${index + 1} amount must be a positive decimal`);
          }
          if (tier.upTo === null) {
            if (index !== (charge.tiers?.length ?? 0) - 1) issues.push(`${chargeAt}: only the final tier can have no upper limit`);
          } else if (!isPositiveDecimal(tier.upTo) || Number(tier.upTo) <= previousLimit) {
            issues.push(`${chargeAt}: tier limits must be positive and ascending`);
          } else previousLimit = Number(tier.upTo);
        }
        if (!ISO_CURRENCIES.has(charge.currency)) issues.push(`${chargeAt}: currency must be an ISO 4217 code`);
        if (!charge.basis) issues.push(`${chargeAt}: basis is required`);
      }
    }
  }
  return issues;
}

/** Import the stable CSV adapter into the canonical nested rate contract. */
export function importRateCsv(
  csv: string,
  sourceFile: string,
  catalog: HeroesRateCatalog,
): RateCatalog {
  const rows = csvToObjects(csv);
  if (rows.length === 0) throw new Error(`${sourceFile}: no rate rows`);
  const { serviceKeys, assetTypes, assetSubtypes, locationRoles } = catalogIndex(catalog);
  const sourceHash = createHash('sha256').update(csv).digest('hex');
  const cards = new Map<string, RateCard>();
  const expectedCardHashes = new Map<string, string>();

  rows.forEach((row, index) => {
    const source = `${sourceFile} row ${index + 2}`;
    const cardId = required(row, 'cardId', source);
    const ruleId = required(row, 'ruleId', source);
    const serviceKey = required(row, 'serviceKey', source);
    if (!serviceKeys.has(serviceKey)) throw new Error(`${source}: unknown Heroes serviceKey ${serviceKey}`);
    const assetType = text(row.assetType);
    if (assetType && !assetTypes.has(assetType)) throw new Error(`${source}: unknown Heroes assetType ${assetType}`);
    const assetSubtype = text(row.assetSubtype);
    if (assetSubtype && !assetType) throw new Error(`${source}: assetSubtype requires assetType`);
    if (assetSubtype && !assetSubtypes.has(`${assetType}\u0000${assetSubtype}`)) {
      throw new Error(`${source}: unknown Heroes asset subtype ${assetType}/${assetSubtype}`);
    }
    const currency = required(row, 'currency', source).toUpperCase();
    if (!ISO_CURRENCIES.has(currency)) throw new Error(`${source}: currency must be an ISO 4217 code`);
    const expectedCardHash = text(row.cardContentHash);
    if (expectedCardHash) {
      if (!/^[a-f0-9]{64}$/.test(expectedCardHash)) throw new Error(`${source}: cardContentHash must be a SHA-256 hash`);
      const previous = expectedCardHashes.get(cardId);
      if (previous && previous !== expectedCardHash) throw new Error(`${source}: conflicting cardContentHash for ${cardId}`);
      expectedCardHashes.set(cardId, expectedCardHash);
    }

    const simpleLocodes: RateRule['locodes'] = [];
    if (text(row.origin)) simpleLocodes.push({ code: text(row.origin).toUpperCase(), role: 'origin' });
    if (text(row.destination)) simpleLocodes.push({ code: text(row.destination).toUpperCase(), role: 'destination' });
    if (text(row.locationCode) || text(row.locationRole)) {
      const role = required(row, 'locationRole', source) as LocationRole;
      if (!locationRoles.has(role)) throw new Error(`${source}: unknown Heroes location role ${role}`);
      simpleLocodes.push({ code: required(row, 'locationCode', source).toUpperCase(), role });
    }
    const locodes = jsonValue<RateRule['locodes']>(row.locodesJson, simpleLocodes, source, 'locodesJson');
    for (const location of locodes) {
      if (!locationRoles.has(location.role)) throw new Error(`${source}: unknown Heroes location role ${location.role}`);
      location.code = required({ code: location.code }, 'code', source).toUpperCase();
    }

    const approvalStatus = required(row, 'approvalStatus', source);
    if (approvalStatus !== 'draft' && approvalStatus !== 'approved') {
      throw new Error(`${source}: approvalStatus must be draft or approved`);
    }
    if (approvalStatus === 'approved' && !expectedCardHash) {
      throw new Error(`${source}: approved CSV rows require cardContentHash`);
    }
    const approvedBy = approvalStatus === 'approved' ? required(row, 'approvedBy', source) : '';
    const approvedAt = approvalStatus === 'approved' ? required(row, 'approvedAt', source) : '';

    let card = cards.get(cardId);
    if (!card) {
      card = {
        id: cardId,
        journeyType: 'OFFER',
        rules: [],
        sourceEvidence: jsonValue<RateCard['sourceEvidence']>(row.sourceEvidenceJson, [{
          sourceFile,
          sourceRef: required(row, 'sourceRef', source),
          sourceHash,
        }], source, 'sourceEvidenceJson'),
        approval: {
          status: approvalStatus, approvedBy, approvedAt,
          ...(approvalStatus === 'approved' ? { contentHash: expectedCardHash } : {}),
        },
        catalogReference: { responseHash: catalog.responseHash, fetchedAt: catalog.fetchedAt },
      };
      cards.set(cardId, card);
    } else if (
      card.approval.status !== approvalStatus ||
      card.approval.approvedBy !== approvedBy ||
      card.approval.approvedAt !== approvedAt
    ) {
      throw new Error(`${source}: card ${cardId} has conflicting approval data`);
    } else if (stableJson(card.sourceEvidence) !== stableJson(
      jsonValue<RateCard['sourceEvidence']>(row.sourceEvidenceJson, [{
        sourceFile, sourceRef: required(row, 'sourceRef', source), sourceHash,
      }], source, 'sourceEvidenceJson'),
    )) {
      throw new Error(`${source}: card ${cardId} has conflicting source evidence`);
    }

    let rule = card.rules.find((item) => item.id === ruleId);
    const simpleTimeframes = text(row.validFrom) || text(row.validTo)
      ? [{ from: text(row.validFrom), to: text(row.validTo) }]
      : [];
    const timeframes = jsonValue<RateRule['timeframes']>(
      row.timeframesJson, simpleTimeframes, source, 'timeframesJson',
    );
    const assetRule = jsonValue<RateRule['assetTypes']>(
      row.assetTypesJson,
      assetType ? [{ type: assetType, subtypes: assetSubtype ? [assetSubtype] : [] }] : [],
      source,
      'assetTypesJson',
    );
    for (const asset of assetRule) {
      if (!assetTypes.has(asset.type)) throw new Error(`${source}: unknown Heroes assetType ${asset.type}`);
      for (const subtype of asset.subtypes ?? []) {
        if (!assetSubtypes.has(`${asset.type}\u0000${subtype}`)) {
          throw new Error(`${source}: unknown Heroes asset subtype ${asset.type}/${subtype}`);
        }
      }
    }
    const participants = jsonValue<RateRule['participants']>(row.participantsJson, [], source, 'participantsJson');
    const strategy = jsonValue<RateRule['strategy']>(row.strategyJson, null, source, 'strategyJson');
    const conditions = jsonValue<string[]>(
      row.conditionsJson,
      text(row.condition) ? [text(row.condition)] : [],
      source,
      'conditionsJson',
    );
    if (!rule) {
      rule = {
        id: ruleId,
        serviceKey,
        locodes,
        timeframes,
        assetTypes: assetRule,
        participants,
        strategy,
        charges: [],
        conditions,
      };
      card.rules.push(rule);
    } else if (stableJson({ serviceKey: rule.serviceKey, locodes: rule.locodes, timeframes: rule.timeframes, assetTypes: rule.assetTypes, participants: rule.participants, strategy: rule.strategy, conditions: rule.conditions }) !== stableJson({ serviceKey, locodes, timeframes, assetTypes: assetRule, participants, strategy, conditions })) {
      throw new Error(`${source}: rule ${ruleId} has conflicting Heroes applicability`);
    }
    const tiers = jsonValue<NonNullable<RateCharge['tiers']>>(row.tiersJson, [], source, 'tiersJson');
    const amount = text(row.amount);
    rule.charges.push({
      chargeKey: required(row, 'chargeKey', source),
      ...(amount ? { amount: positiveDecimal(amount, source) } : {}),
      currency,
      basis: required(row, 'basis', source),
      ...(text(row.minimum) ? { minimum: positiveDecimal(text(row.minimum), source, 'minimum') } : {}),
      ...(text(row.maximum) ? { maximum: positiveDecimal(text(row.maximum), source, 'maximum') } : {}),
      ...(tiers.length ? { tiers } : {}),
    });
  });

  const imported: RateCatalog = {
    schemaVersion: RATE_CONTRACT_VERSION,
    rateCards: [...cards.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
  for (const card of imported.rateCards) {
    const expected = expectedCardHashes.get(card.id);
    if (expected && computeRateCardHash(card) !== expected) {
      throw new Error(`${sourceFile}: card ${card.id} content changed after approval; remove approval and approve a new import`);
    }
  }
  const issues = validateRateCatalog(imported, catalog);
  if (issues.length) throw new Error(issues.join('; '));
  return imported;
}

/** Export the nested contract as repeatable charge rows plus lossless JSON applicability columns. */
export function exportRateCsv(rateCatalog: RateCatalog): string {
  const rows: Record<string, unknown>[] = [];
  for (const card of rateCatalog.rateCards) {
    for (const rule of card.rules) {
      const origin = rule.locodes.find((item) => item.role === 'origin')?.code ?? '';
      const destination = rule.locodes.find((item) => item.role === 'destination')?.code ?? '';
      const extraLocation = rule.locodes.find((item) => !['origin', 'destination'].includes(item.role));
      const asset = rule.assetTypes[0];
      const validity = rule.timeframes[0];
      for (const charge of rule.charges) {
        rows.push({
          cardId: card.id,
          ruleId: rule.id,
          serviceKey: rule.serviceKey,
          origin,
          destination,
          locationCode: extraLocation?.code ?? '',
          locationRole: extraLocation?.role ?? '',
          assetType: asset?.type ?? '',
          assetSubtype: asset?.subtypes[0] ?? '',
          validFrom: validity?.from ?? '',
          validTo: validity?.to ?? '',
          chargeKey: charge.chargeKey,
          amount: charge.amount,
          currency: charge.currency,
          basis: charge.basis,
          minimum: charge.minimum ?? '',
          maximum: charge.maximum ?? '',
          tiersJson: JSON.stringify(charge.tiers ?? []),
          sourceRef: card.sourceEvidence[0]?.sourceRef ?? '',
          approvalStatus: card.approval.status,
          approvedBy: card.approval.approvedBy,
          approvedAt: card.approval.approvedAt,
          condition: rule.conditions[0] ?? '',
          locodesJson: JSON.stringify(rule.locodes),
          assetTypesJson: JSON.stringify(rule.assetTypes),
          participantsJson: JSON.stringify(rule.participants),
          strategyJson: JSON.stringify(rule.strategy),
          conditionsJson: JSON.stringify(rule.conditions),
          sourceEvidenceJson: JSON.stringify(card.sourceEvidence),
          timeframesJson: JSON.stringify(rule.timeframes),
          cardContentHash: card.approval.contentHash ?? '',
        });
      }
    }
  }
  return objectsToCsv(rows, [...RATE_CSV_COLUMNS]);
}

/** Return one safe result, or an explicit non-quotable state. Never ranks by price. */
export function discoverRate(
  rateCatalog: RateCatalog,
  heroesCatalog: HeroesRateCatalog,
  query: RateDiscoveryQuery,
): RateDiscovery {
  const issues = validateRateCatalog(rateCatalog, heroesCatalog);
  if (issues.length) {
    return { status: 'invalid', match: false, reason: issues.join('; '), query, candidates: [] };
  }
  const index = catalogIndex(heroesCatalog);
  const queryIssues: string[] = [];
  if (!index.serviceKeys.has(query.serviceKey)) queryIssues.push(`unknown Heroes serviceKey ${query.serviceKey}`);
  for (const timeframe of query.timeframes ?? []) {
    if (!timeframe.from && !timeframe.to) queryIssues.push('query timeframe requires from or to');
    if (timeframe.from && !isIsoDate(timeframe.from)) queryIssues.push(`invalid timeframe from ${timeframe.from}`);
    if (timeframe.to && !isIsoDate(timeframe.to)) queryIssues.push(`invalid timeframe to ${timeframe.to}`);
    if (timeframe.from && timeframe.to && timeframe.from > timeframe.to) {
      queryIssues.push('query timeframe from cannot exceed to');
    }
  }
  for (const location of query.locodes) {
    if (!index.locationRoles.has(location.role)) queryIssues.push(`unknown Heroes location role ${location.role}`);
  }
  for (const asset of query.assetTypes ?? []) {
    if (!index.assetTypes.has(asset.type)) queryIssues.push(`unknown Heroes assetType ${asset.type}`);
    for (const subtype of asset.subtypes) {
      if (!index.assetSubtypes.has(`${asset.type}\u0000${subtype}`)) {
        queryIssues.push(`unknown Heroes asset subtype ${asset.type}/${subtype}`);
      }
    }
  }
  for (const participant of query.participants ?? []) {
    if (!index.participantRoles.has(participant.role)) {
      queryIssues.push(`unknown Heroes participant role ${participant.role}`);
    }
  }
  if (query.strategy) {
    const steps = index.strategies.get(query.strategy.strategyKey);
    if (!steps) queryIssues.push(`unknown Heroes strategy ${query.strategy.strategyKey}`);
    else if (query.strategy.currentStep && !steps.has(query.strategy.currentStep)) {
      queryIssues.push(`unknown Heroes strategy step ${query.strategy.strategyKey}/${query.strategy.currentStep}`);
    }
  }
  if (queryIssues.length) {
    return { status: 'invalid', match: false, reason: queryIssues.join('; '), query, candidates: [] };
  }
  const candidates: RateCandidate[] = [];
  const incomplete: RateCandidate[] = [];
  const ineligible: RateCandidate[] = [];
  for (const card of rateCatalog.rateCards) {
    for (const rule of card.rules) {
      if (rule.serviceKey !== query.serviceKey) continue;
      if (rule.locodes.some((actual) => {
        const sameRole = query.locodes.filter((wanted) => wanted.role === actual.role);
        return sameRole.length > 0 && !sameRole.some((wanted) =>
          wanted.code.toUpperCase() === actual.code.toUpperCase(),
        );
      })) continue;
      if (query.timeframes?.some((wanted) => !rule.timeframes.some((actual) =>
        (wanted.from ? !actual.from || wanted.from >= actual.from : !actual.from) &&
        (wanted.to ? !actual.to || wanted.to <= actual.to : !actual.to),
      ))) continue;
      if (rule.assetTypes.some((actual) => {
        const wanted = query.assetTypes?.find((item) => item.type === actual.type);
        if (query.assetTypes?.length && !wanted) return true;
        return wanted && actual.subtypes.length > 0 && wanted.subtypes.length > 0 &&
          !wanted.subtypes.some((subtype) => actual.subtypes.includes(subtype));
      })) continue;
      const participantRoles = new Set(rule.participants.map((participant) => participant.role));
      if ([...participantRoles].some((role) => {
        const actual = rule.participants.filter((participant) => participant.role === role);
        const wanted = query.participants?.filter((participant) => participant.role === role) ?? [];
        return wanted.length > 0 && !wanted.some((candidate) =>
          actual.some((allowed) => allowed.tenantKey === candidate.tenantKey),
        );
      })) continue;
      if (rule.strategy && query.strategy && (
        rule.strategy.strategyKey !== query.strategy.strategyKey ||
        (query.strategy.currentStep && rule.strategy.currentStep !== query.strategy.currentStep)
      )) continue;

      const missingFacts: string[] = [];
      for (const actual of rule.locodes) {
        if (!query.locodes.some((wanted) =>
          wanted.role === actual.role && wanted.code.toUpperCase() === actual.code.toUpperCase(),
        )) missingFacts.push(`location ${actual.code}:${actual.role}`);
      }
      if (rule.timeframes.length && !query.timeframes?.length) missingFacts.push('timeframe');
      for (const actual of rule.assetTypes) {
        const wanted = query.assetTypes?.find((asset) => asset.type === actual.type);
        if (!wanted) missingFacts.push(`asset type ${actual.type}`);
        else if (actual.subtypes.length && !wanted.subtypes.some((subtype) => actual.subtypes.includes(subtype))) {
          missingFacts.push(`asset subtype ${actual.type} (${actual.subtypes.join(' or ')})`);
        }
      }
      for (const role of participantRoles) {
        const actual = rule.participants.filter((participant) => participant.role === role);
        if (!query.participants?.some((wanted) =>
          wanted.role === role && actual.some((allowed) => allowed.tenantKey === wanted.tenantKey),
        )) missingFacts.push(`participant ${actual.map((item) => item.tenantKey).join(' or ')}:${role}`);
      }
      if (rule.strategy && !query.strategy) missingFacts.push(`strategy ${rule.strategy.strategyKey}`);
      else if (rule.strategy?.currentStep && !query.strategy?.currentStep) {
        missingFacts.push(`strategy step ${rule.strategy.currentStep}`);
      }
      const ineligibleReasons: string[] = [];
      if (card.approval.status !== 'approved') ineligibleReasons.push('rate card is not approved');
      if (card.catalogReference.responseHash !== heroesCatalog.responseHash) {
        ineligibleReasons.push('rate card does not reference the active Heroes catalog');
      }
      const candidate = {
        cardId: card.id, rule, sourceEvidence: card.sourceEvidence, missingFacts, ineligibleReasons,
      };
      if (ineligibleReasons.length) ineligible.push(candidate);
      else if (missingFacts.length) incomplete.push(candidate);
      else candidates.push(candidate);
    }
  }

  const evidence = [...candidates, ...incomplete, ...ineligible];

  if (incomplete.length) {
    const facts = [...new Set(incomplete.flatMap((candidate) => candidate.missingFacts))];
    return {
      status: 'incomplete', match: false,
      reason: `shipment facts are required: ${facts.join(', ')}`,
      query, candidates: evidence,
    };
  }
  if (candidates.length === 0) {
    const reason = ineligible.length
      ? `stored rate rules are not automatically usable: ${ineligible.map((candidate) =>
        `${candidate.cardId}/${candidate.rule.id}: ${candidate.ineligibleReasons.join(', ')}`).join('; ')}`
      : 'no complete approved current valid rate rule applies';
    return {
      status: 'none', match: false, reason, query, candidates: evidence,
    };
  }
  if (candidates.length > 1) {
    return {
      status: 'ambiguous', match: false,
      reason: `${candidates.length === 2 ? 'two' : candidates.length} complete approved current valid rate rules apply; human resolution is required`,
      query, candidates: evidence,
    };
  }
  return {
    status: 'matched', match: true,
    reason: 'one complete approved current valid rate rule applies',
      query, rate: candidates[0], candidates: evidence,
  };
}
