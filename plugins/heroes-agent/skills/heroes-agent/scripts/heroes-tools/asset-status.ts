/**
 * asset-status — read-only check of how assets are typed and bound to services, through the documented Heroes read endpoints.
 *
 * For each `--ref <refId>`:
 *   GET /assets/{ref_id}                               the asset, its type and external refs
 *   GET /catalog/asset-types                           the catalog entry for that type ({ code, name, description })
 *   GET /catalog/reference-types?asset_type=<type>     whether each external ref type is valid for the type
 *   GET /catalog/asset-subtypes?asset_type=<type>      subtypes defined for the type
 * For each `--service <serviceId>`:
 *   GET /services/{id}/assets/manifest                 manifest entries with their role (cargo | transport | document)
 *   GET /services/{id}/assets                          the cargo/transport binding view (no role field)
 *   GET /services/{id}/assets/relationships            asset-to-asset edges
 *   GET /services/{id}/asset-events                    event-to-asset links
 *
 * It writes nothing. It reports, per service, when a manifest entry with role
 * `document` also appears as `cargoAssetId` in GET /services/{id}/assets: that
 * endpoint is documented as "cargo and transport" and returns no role, so a
 * reader of that view alone sees the document as cargo.
 *
 * Usage:
 *   npx tsx asset-status.ts [--ref <refId> ...] [--service <serviceId> ...] [--json]
 *
 * Example:
 *   npx tsx asset-status.ts --ref 4500012345 --service 11111111-1111-4111-8111-111111111111
 */
import { run, parseArgs, flagValues, requireApiKey, api, ApiError, heading, kv, type Config } from './lib';

const USAGE = 'Usage: npx tsx asset-status.ts [--ref <refId> ...] [--service <serviceId> ...] [--json]';

/** GET that returns null on 404 (asset unknown, or service not visible to this tenant). */
async function getOrNull<T>(config: Config, apiKey: string, path: string): Promise<T | null> {
  try {
    return await api<T>(config, { method: 'GET', path, apiKey });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

const list = (value: any, key: string): any[] => (Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : []);

run(async (config) => {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const refs = flagValues(argv, 'ref');
  const serviceIds = flagValues(argv, 'service');
  const asJson = flags.json === true;
  if (refs.length === 0 && serviceIds.length === 0) throw new Error(USAGE);
  const apiKey = requireApiKey(config);

  const catalog = list(await api<any>(config, { method: 'GET', path: '/catalog/asset-types', apiKey }), 'asset_types');

  const assets = [];
  for (const refId of refs) {
    const asset = await getOrNull<any>(config, apiKey, `/assets/${encodeURIComponent(refId)}`);
    if (!asset) {
      assets.push({ refId, found: false });
      continue;
    }
    const type = String(asset.type ?? '');
    const q = `?asset_type=${encodeURIComponent(type)}`;
    const refTypes = list(await api<any>(config, { method: 'GET', path: `/catalog/reference-types${q}`, apiKey }), 'reference_types')
      .map((r) => String(r.code));
    const subtypes = list(await api<any>(config, { method: 'GET', path: `/catalog/asset-subtypes${q}`, apiKey }), 'asset_subtypes')
      .map((s) => String(s.subtype));
    const externalRefs = (asset.externalRefs ?? []).map((r: any) => ({
      refType: String(r.refType),
      refId: String(r.refId),
      validForType: refTypes.includes(String(r.refType)),
    }));
    assets.push({
      refId,
      found: true,
      id: asset.id,
      type,
      name: asset.name,
      participants: (asset.participants ?? []).map((p: any) => ({ tenantKey: p.tenantKey, role: p.role })),
      externalRefs,
      catalogEntry: catalog.find((entry) => entry.code === type) ?? null,
      subtypesForType: subtypes,
    });
  }

  const services = [];
  for (const serviceId of serviceIds) {
    const manifestData = await getOrNull<any>(config, apiKey, `/services/${serviceId}/assets/manifest`);
    if (manifestData === null) {
      services.push({ serviceId, visible: false });
      continue;
    }
    const manifest = list(manifestData, 'manifest').map((e) => ({
      id: e.id,
      assetId: Number(e.assetId),
      role: String(e.role),
      assetType: e.asset?.type ?? null,
    }));
    const bindings = list(await getOrNull<any>(config, apiKey, `/services/${serviceId}/assets`), 'serviceAssets').map((b) => ({
      id: b.id,
      cargoAssetId: b.cargoAssetId ?? null,
      transportAssetId: b.transportAssetId ?? null,
    }));
    const relationships = list(await getOrNull<any>(config, apiKey, `/services/${serviceId}/assets/relationships`), 'relationships');
    const assetEvents = list(await getOrNull<any>(config, apiKey, `/services/${serviceId}/asset-events`), 'assetEvents');
    const notes = manifest
      .filter((e) => e.role === 'document' && bindings.some((b) => Number(b.cargoAssetId) === e.assetId))
      .map(
        (e) =>
          `manifest entry ${e.id} (asset ${e.assetId}, role document) is also listed as cargoAssetId by ` +
          'GET /services/{id}/assets, which is documented as "cargo and transport" and has no role field',
      );
    services.push({ serviceId, visible: true, manifest, serviceAssets: bindings, relationships: relationships.length, assetEvents: assetEvents.length, notes });
  }

  const summary = { assets, services };
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  for (const a of assets as any[]) {
    heading(`Asset ${a.refId}`);
    if (!a.found) {
      console.log('  (no asset with this reference)');
      continue;
    }
    kv('id', a.id);
    kv('type', a.type);
    kv('name', a.name);
    kv('catalog entry', a.catalogEntry ? JSON.stringify(a.catalogEntry) : '(type not in catalog)');
    for (const r of a.externalRefs) kv(`ref ${r.refType}`, `${r.refId}${r.validForType ? '' : ' (ref type not listed for this asset type)'}`);
    kv('subtypes for type', a.subtypesForType.length ? a.subtypesForType.join(', ') : '(none)');
  }
  for (const s of services as any[]) {
    heading(`Service ${s.serviceId}`);
    if (!s.visible) {
      console.log('  (not visible to this tenant)');
      continue;
    }
    if (s.manifest.length === 0) console.log('  manifest: (none)');
    for (const e of s.manifest) console.log(`  manifest • [${e.assetId}] ${e.role} (${e.assetType ?? '?'})`);
    for (const b of s.serviceAssets) console.log(`  binding  • cargo ${b.cargoAssetId ?? '-'} transport ${b.transportAssetId ?? '-'}`);
    kv('relationships', s.relationships);
    kv('asset events', s.assetEvents);
    for (const n of s.notes) console.log(`  note: ${n}`);
  }
});
