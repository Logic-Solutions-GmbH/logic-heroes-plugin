import {
  chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const RATE_PROFILE_VERSION = '1.0' as const;
export const RATE_PROFILE_PATH = 'self/supabase/rate-profile.json' as const;
const SUPABASE_BINDING_PATH = 'self/supabase/binding.json' as const;

export const REQUIRED_RATE_SEMANTICS = [
  'tenant.key',
  'card.id',
  'card.journeyType',
  'rule.id',
  'rule.serviceKey',
  'rule.locodes',
  'rule.timeframes',
  'rule.assetTypes',
  'rule.participants',
  'rule.strategy',
  'charge.chargeKey',
  'charge.amount',
  'charge.currency',
  'charge.basis',
  'charge.minimum',
  'charge.maximum',
  'charge.tiers',
  'rule.conditions',
  'source.sourceFile',
  'source.sourceRef',
  'source.sourceHash',
  'approval.status',
  'approval.approvedBy',
  'approval.approvedAt',
  'approval.contentHash',
  'catalog.responseHash',
  'catalog.fetchedAt',
] as const;

export type RateSemantic = typeof REQUIRED_RATE_SEMANTICS[number];
export type RateResourceKind = 'table' | 'view' | 'function';

interface RateOperationDeclaration {
  resource: string;
  contract: 'rate-contract-1.0';
  securityMode: 'invoker';
  tenantEnforcement: {
    method: 'database-rls';
    tenantField: 'tenant.key';
    contextKey: 'heroes_tenant_key';
  };
}

export interface RateProfileIdentity {
  heroesTenantKey: string;
  supabaseProjectRef: string;
}

export interface RateProfile {
  profileVersion: typeof RATE_PROFILE_VERSION;
  status: 'proposal' | 'confirmed';
  binding: RateProfileIdentity;
  resources: { id: string; kind: RateResourceKind; name: string }[];
  operations: Record<'ingest' | 'discover' | 'list', RateOperationDeclaration>;
  fields: { semantic: RateSemantic; resource: string; path: string }[];
  controls: {
    tenantIsolation: {
      method: 'rls';
      tenantField: 'tenant.key';
      protectedResources: string[];
    };
    grants: {
      public: 'none';
      anon: 'none';
      authenticated: 'none';
      operationalRole: string;
      coveredResources: string[];
    };
    approval: {
      statusField: 'approval.status';
      approvedByField: 'approval.approvedBy';
      approvedAtField: 'approval.approvedAt';
      contentHashField: 'approval.contentHash';
      rule: 'valid-content-hash';
    };
    current: {
      catalogHashField: 'catalog.responseHash';
      rule: 'equals-active-heroes-catalog';
    };
    validity: {
      timeframesField: 'rule.timeframes';
      rule: 'contains-query-window';
    };
    provenance: { fields: RateSemantic[] };
    idempotency: { fields: RateSemantic[]; resource: string; constraint: string };
  };
}

export interface NormalizedRateProfileContract {
  profileVersion: typeof RATE_PROFILE_VERSION;
  semantics: RateSemantic[];
  operations: ('discover' | 'ingest' | 'list')[];
  controls: {
    tenantIsolation: 'rls';
    operationTenantIsolation: 'invoker-database-rls';
    grants: 'private';
    approval: 'valid-content-hash';
    current: 'equals-active-heroes-catalog';
    validity: 'contains-query-window';
    provenance: RateSemantic[];
    idempotency: RateSemantic[];
  };
}

export function resolveRateField(
  profile: RateProfile,
  semantic: RateSemantic,
): { resource: RateProfile['resources'][number]; path: string } {
  if (profile.status !== 'confirmed') throw new Error('Confirmed rate profile required');
  const field = profile.fields.find((candidate) => candidate.semantic === semantic);
  if (!field) throw new Error(`Rate profile does not map semantic field: ${semantic}`);
  const resource = profile.resources.find((candidate) => candidate.id === field.resource);
  if (!resource) throw new Error(`Rate profile uses unknown resource: ${field.resource}`);
  return { resource, path: field.path };
}

export function resolveRateOperation(
  profile: RateProfile,
  operation: keyof RateProfile['operations'],
): RateProfile['resources'][number] {
  if (profile.status !== 'confirmed') throw new Error('Confirmed rate profile required');
  const resourceId = profile.operations[operation].resource;
  const resource = profile.resources.find((candidate) => candidate.id === resourceId);
  if (!resource) throw new Error(`Rate profile uses unknown resource: ${resourceId}`);
  return resource;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value as string[];
}

function expect(value: unknown, expected: string, message: string): void {
  if (value !== expected) throw new Error(message);
}

function unique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} is ambiguous: ${value}`);
    seen.add(value);
  }
}

function exactSet(actual: string[], expected: readonly string[], label: string): void {
  unique(actual, label);
  for (const value of expected) if (!actual.includes(value)) throw new Error(`${label} is missing: ${value}`);
  for (const value of actual) if (!expected.includes(value)) throw new Error(`${label} is unsupported: ${value}`);
}

function parseResources(value: unknown): RateProfile['resources'] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('resources must be a non-empty array');
  const resources = value.map((item, index) => {
    const source = record(item, `resources[${index}]`);
    const id = text(source.id, `resources[${index}].id`);
    const kind = text(source.kind, `resources[${index}].kind`);
    const name = text(source.name, `resources[${index}].name`);
    if (!['table', 'view', 'function'].includes(kind)) throw new Error(`Unsupported resource kind: ${kind}`);
    if (!/^[a-z_][a-z0-9_]*$/.test(id)) throw new Error(`Invalid resource id: ${id}`);
    if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Invalid qualified resource name: ${name}`);
    return { id, kind: kind as RateResourceKind, name };
  });
  unique(resources.map(({ id }) => id), 'resource id');
  unique(resources.map(({ name }) => name), 'resource name');
  return resources;
}

function parseOperations(
  value: unknown,
  resources: RateProfile['resources'],
): RateProfile['operations'] {
  const source = record(value, 'operations');
  const operations = Object.fromEntries((['ingest', 'discover', 'list'] as const).map((operation) => {
    const declaration = record(source[operation], `operations.${operation}`);
    const resource = text(declaration.resource, `operations.${operation}.resource`);
    expect(
      declaration.contract,
      'rate-contract-1.0',
      `Operation ${operation} must use rate-contract-1.0`,
    );
    expect(
      declaration.securityMode,
      'invoker',
      `Operation ${operation} must use invoker security`,
    );
    if (!declaration.tenantEnforcement) {
      throw new Error(`Operation ${operation} must declare database RLS tenant enforcement`);
    }
    const tenant = record(declaration.tenantEnforcement, `operations.${operation}.tenantEnforcement`);
    expect(
      tenant.method,
      'database-rls',
      `Operation ${operation} must declare database RLS tenant enforcement`,
    );
    if (tenant.tenantField !== 'tenant.key' || tenant.contextKey !== 'heroes_tenant_key') {
      throw new Error(`Operation ${operation} must bind tenant.key to heroes_tenant_key`);
    }
    return [operation, {
      resource,
      contract: 'rate-contract-1.0' as const,
      securityMode: 'invoker' as const,
      tenantEnforcement: {
        method: 'database-rls' as const,
        tenantField: 'tenant.key' as const,
        contextKey: 'heroes_tenant_key' as const,
      },
    }];
  })) as RateProfile['operations'];
  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));
  for (const [operation, declaration] of Object.entries(operations)) {
    const resourceId = declaration.resource;
    if (!resourcesById.has(resourceId)) throw new Error(`Operation ${operation} uses unknown resource: ${resourceId}`);
  }
  if (resourcesById.get(operations.ingest.resource)?.kind !== 'function') {
    throw new Error('Ingest operation must use a function resource');
  }
  for (const operation of ['discover', 'list'] as const) {
    if (resourcesById.get(operations[operation].resource)?.kind !== 'view') {
      throw new Error(`${operation} operation must use a view resource`);
    }
  }
  return operations;
}

function parseFields(value: unknown, resources: RateProfile['resources']): RateProfile['fields'] {
  if (!Array.isArray(value)) throw new Error('fields must be an array');
  const resourceKinds = new Map(resources.map(({ id, kind }) => [id, kind]));
  const fields = value.map((item, index) => {
    const source = record(item, `fields[${index}]`);
    const semantic = text(source.semantic, `fields[${index}].semantic`);
    const resource = text(source.resource, `fields[${index}].resource`);
    const path = text(source.path, `fields[${index}].path`);
    if (!REQUIRED_RATE_SEMANTICS.includes(semantic as RateSemantic)) {
      throw new Error(`unsupported semantic field: ${semantic}`);
    }
    if (!resourceKinds.has(resource)) throw new Error(`Semantic field ${semantic} uses unknown resource: ${resource}`);
    if (resourceKinds.get(resource) !== 'table') throw new Error(`Semantic field ${semantic} must map to a table resource`);
    if (!/^([a-z_][a-z0-9_]*|\/(?:[^/~]|~[01])+(?:\/(?:[^/~]|~[01])+)*?)$/.test(path)) {
      throw new Error(`Invalid structured field path for ${semantic}: ${path}`);
    }
    return { semantic: semantic as RateSemantic, resource, path };
  });
  const semantics = fields.map(({ semantic }) => semantic);
  unique(semantics, 'semantic field');
  unique(fields.map(({ resource, path }) => `${resource}/${path}`), 'physical field');
  for (const semantic of REQUIRED_RATE_SEMANTICS) {
    if (!semantics.includes(semantic)) throw new Error(`missing required semantic field: ${semantic}`);
  }
  return fields;
}

function validateControls(
  value: unknown,
  resources: RateProfile['resources'],
  fields: RateProfile['fields'],
): RateProfile['controls'] {
  const controls = record(value, 'controls');
  if (!controls.tenantIsolation) throw new Error('tenant isolation must use database RLS with tenant.key');
  const isolation = record(controls.tenantIsolation, 'controls.tenantIsolation');
  if (isolation.method !== 'rls' || isolation.tenantField !== 'tenant.key') {
    throw new Error('tenant isolation must use database RLS with tenant.key');
  }
  const protectedResources = strings(isolation.protectedResources, 'protectedResources');
  const mappedTables = [...new Set(fields.map(({ resource }) => resource))].sort();
  unique(protectedResources, 'RLS resource');
  for (const resource of mappedTables) {
    if (!protectedResources.includes(resource)) throw new Error(`RLS must protect mapped table: ${resource}`);
  }
  for (const resource of protectedResources) {
    if (!mappedTables.includes(resource)) throw new Error(`RLS declaration uses unmapped table: ${resource}`);
  }

  const grants = record(controls.grants, 'controls.grants');
  if (grants.public !== 'none' || grants.anon !== 'none' || grants.authenticated !== 'none') {
    throw new Error('direct grants for PUBLIC, anon, and authenticated must be none');
  }
  const operationalRole = text(grants.operationalRole, 'controls.grants.operationalRole');
  if (!/^[a-z_][a-z0-9_]*$/.test(operationalRole)) throw new Error(`Invalid operational role: ${operationalRole}`);
  const coveredResources = strings(grants.coveredResources, 'coveredResources');
  unique(coveredResources, 'grant resource');
  for (const { id } of resources) {
    if (!coveredResources.includes(id)) throw new Error(`grant declaration must cover resource: ${id}`);
  }
  for (const resource of coveredResources) {
    if (!resources.some(({ id }) => id === resource)) throw new Error(`grant declaration uses unknown resource: ${resource}`);
  }

  const approval = record(controls.approval, 'controls.approval');
  expect(approval.statusField, 'approval.status', 'approval control must name approval.status');
  expect(approval.approvedByField, 'approval.approvedBy', 'approval control must name approval.approvedBy');
  expect(approval.approvedAtField, 'approval.approvedAt', 'approval control must name approval.approvedAt');
  expect(approval.contentHashField, 'approval.contentHash', 'approval control must name approval.contentHash');
  expect(approval.rule, 'valid-content-hash', 'approval control must require a valid content hash');

  const current = record(controls.current, 'controls.current');
  expect(current.catalogHashField, 'catalog.responseHash', 'current control must name catalog.responseHash');
  expect(current.rule, 'equals-active-heroes-catalog', 'current control must compare the active Heroes catalog');

  const validity = record(controls.validity, 'controls.validity');
  expect(validity.timeframesField, 'rule.timeframes', 'validity control must name rule.timeframes');
  expect(validity.rule, 'contains-query-window', 'validity control must contain the query window');

  const provenance = record(controls.provenance, 'controls.provenance');
  const provenanceFields = strings(provenance.fields, 'controls.provenance.fields') as RateSemantic[];
  exactSet(
    provenanceFields,
    ['source.sourceFile', 'source.sourceRef', 'source.sourceHash', 'catalog.responseHash', 'catalog.fetchedAt'],
    'provenance field',
  );

  const idempotency = record(controls.idempotency, 'controls.idempotency');
  const idempotencyFields = strings(idempotency.fields, 'controls.idempotency.fields') as RateSemantic[];
  exactSet(
    idempotencyFields,
    ['tenant.key', 'card.id', 'rule.id', 'source.sourceHash'],
    'idempotency field',
  );
  const idempotencyResource = text(idempotency.resource, 'controls.idempotency.resource');
  if (!resources.some(({ id, kind }) => id === idempotencyResource && kind === 'table')) {
    throw new Error(`idempotency resource must be a table: ${idempotencyResource}`);
  }
  for (const semantic of idempotencyFields) {
    const mapping = fields.find((field) => field.semantic === semantic);
    if (mapping?.resource !== idempotencyResource) {
      throw new Error(`idempotency field ${semantic} must map to table resource: ${idempotencyResource}`);
    }
  }
  const constraint = text(idempotency.constraint, 'controls.idempotency.constraint');
  if (!/^[a-z_][a-z0-9_]*$/.test(constraint)) throw new Error(`Invalid idempotency constraint: ${constraint}`);

  return {
    tenantIsolation: { method: 'rls', tenantField: 'tenant.key', protectedResources },
    grants: {
      public: 'none', anon: 'none', authenticated: 'none', operationalRole, coveredResources,
    },
    approval: {
      statusField: 'approval.status',
      approvedByField: 'approval.approvedBy',
      approvedAtField: 'approval.approvedAt',
      contentHashField: 'approval.contentHash',
      rule: 'valid-content-hash',
    },
    current: { catalogHashField: 'catalog.responseHash', rule: 'equals-active-heroes-catalog' },
    validity: { timeframesField: 'rule.timeframes', rule: 'contains-query-window' },
    provenance: { fields: provenanceFields },
    idempotency: { fields: idempotencyFields, resource: idempotencyResource, constraint },
  };
}

export function parseRateProfile(value: unknown, expectedIdentity: RateProfileIdentity): RateProfile {
  const source = record(value, 'rate profile');
  if (source.profileVersion !== RATE_PROFILE_VERSION) {
    throw new Error(`Unsupported rate profile version: ${String(source.profileVersion)}`);
  }
  if (source.status !== 'proposal' && source.status !== 'confirmed') {
    throw new Error('rate profile status must be proposal or confirmed');
  }
  const binding = record(source.binding, 'binding');
  const heroesTenantKey = text(binding.heroesTenantKey, 'binding.heroesTenantKey');
  const supabaseProjectRef = text(binding.supabaseProjectRef, 'binding.supabaseProjectRef');
  if (!/^[a-z0-9]{20}$/.test(supabaseProjectRef)) throw new Error('Invalid Supabase project identity');
  if (heroesTenantKey !== expectedIdentity.heroesTenantKey) throw new Error('Heroes tenant identity mismatch');
  if (supabaseProjectRef !== expectedIdentity.supabaseProjectRef) throw new Error('Supabase project identity mismatch');

  const resources = parseResources(source.resources);
  const operations = parseOperations(source.operations, resources);
  const fields = parseFields(source.fields, resources);
  const controls = validateControls(source.controls, resources, fields);
  return {
    profileVersion: RATE_PROFILE_VERSION,
    status: source.status,
    binding: { heroesTenantKey, supabaseProjectRef },
    resources,
    operations,
    fields,
    controls,
  };
}

export function normalizeRateProfile(profile: RateProfile): NormalizedRateProfileContract {
  return {
    profileVersion: RATE_PROFILE_VERSION,
    semantics: [...REQUIRED_RATE_SEMANTICS].sort(),
    operations: ['discover', 'ingest', 'list'],
    controls: {
      tenantIsolation: 'rls',
      operationTenantIsolation: 'invoker-database-rls',
      grants: 'private',
      approval: profile.controls.approval.rule,
      current: profile.controls.current.rule,
      validity: profile.controls.validity.rule,
      provenance: [...profile.controls.provenance.fields].sort(),
      idempotency: [...profile.controls.idempotency.fields].sort(),
    },
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${stableJson(source[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function loadBoundIdentity(workspace: string): RateProfileIdentity {
  const path = join(workspace, SUPABASE_BINDING_PATH);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Supabase binding is missing or invalid: ${SUPABASE_BINDING_PATH}`);
  }
  const binding = record(value, 'Supabase binding');
  const heroesTenantKey = text(binding.heroesTenantKey, 'Supabase binding heroesTenantKey');
  const supabaseProjectRef = text(binding.supabaseProjectRef, 'Supabase binding supabaseProjectRef');
  if (!/^[a-z0-9]{20}$/.test(supabaseProjectRef)) throw new Error('Supabase binding project identity is invalid');
  return { heroesTenantKey, supabaseProjectRef };
}

export function persistConfirmedRateProfile(
  workspace: string,
  value: unknown,
): string {
  const profile = parseRateProfile(value, loadBoundIdentity(workspace));
  if (profile.status !== 'confirmed') throw new Error('Only a confirmed rate profile can be persisted');
  const path = join(workspace, RATE_PROFILE_PATH);
  const temporaryPath = `${path}.next`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporaryPath, `${stableJson(profile)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
  return path;
}

export function loadConfirmedRateProfile(
  workspace: string,
): RateProfile {
  const path = join(workspace, RATE_PROFILE_PATH);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Rate profile is missing or invalid: ${RATE_PROFILE_PATH}`);
  }
  const profile = parseRateProfile(value, loadBoundIdentity(workspace));
  if (profile.status !== 'confirmed') throw new Error('Confirmed rate profile required');
  return profile;
}
