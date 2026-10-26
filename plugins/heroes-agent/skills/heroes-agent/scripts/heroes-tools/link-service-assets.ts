/**
 * link-service-assets — declare shipment assets (find-or-create by external reference) and bind them to a service manifest, idempotently.
 *
 * For each `--asset <assetType>:<refType>:<refId>`:
 *   1. GET /assets/{refId}; reuse the asset when type and (refType, refId) match.
 *      A different asset under the same reference stops the run (no duplicate).
 *   2. Otherwise POST /assets { type, name, externalRef: { refType, refId } }.
 *   3. GET /services/{id}/assets/manifest, then POST /services/{id}/assets/manifest
 *      with only the (assetId, role) pairs that are missing, then read it back.
 * A re-run creates no asset and no manifest entry.
 *
 * The role defaults from the asset type: vessel/plane/truck/train/barge/trailer
 * → transport; container/box/pallet/cargo → cargo; document types such as
 * purchase_order, hbl, mbl, booking → document. `--role` overrides it for all.
 *
 * Bind assets only to the service that carries the shipment and its milestones.
 * Do not bind them to an integration-only (shadow) service: asset-based tracking
 * would show it. `--expect-assignee` refuses to write unless the service's
 * assignee is that tenant.
 *
 * Usage:
 *   npx tsx link-service-assets.ts <service-id> --asset <type>:<refType>:<refId> \
 *       [--asset ...] [--name <text> ...] [--role cargo|transport|document] \
 *       [--expect-assignee <tenantKey>] [--dry-run] [--json]
 *
 * Example:
 *   npx tsx link-service-assets.ts 11111111-1111-4111-8111-111111111111 \
 *       --asset purchase_order:purchase_order_number:4500012345 \
 *       --expect-assignee example-forwarder
 */
import {
  run,
  parseArgs,
  flagString,
  flagValues,
  requireApiKey,
  api,
  parseAssetSpec,
  declareAsset,
  linkServiceAssets,
  defaultManifestRole,
  MANIFEST_ROLES,
  type ManifestRole,
  heading,
  kv,
} from './lib';

const USAGE =
  'Usage: npx tsx link-service-assets.ts <service-id> --asset <assetType>:<refType>:<refId> ' +
  '[--asset ...] [--name <text> ...] [--role cargo|transport|document] ' +
  '[--expect-assignee <tenantKey>] [--dry-run] [--json]';

run(async (config) => {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const serviceId = positional[0];
  const specs = flagValues(argv, 'asset').map(parseAssetSpec);
  const names = flagValues(argv, 'name');
  const roleFlag = flagString(flags, 'role');
  const expectAssignee = flagString(flags, 'expect-assignee');
  const dryRun = 'dry-run' in flags;
  const asJson = flags.json === true;

  if (!serviceId || specs.length === 0) throw new Error(USAGE);
  if (names.length > 0 && names.length !== specs.length) {
    throw new Error('Give one --name per --asset, in the same order, or none.');
  }
  if (roleFlag && !(MANIFEST_ROLES as readonly string[]).includes(roleFlag)) {
    throw new Error(`--role must be one of ${MANIFEST_ROLES.join(', ')}`);
  }

  const apiKey = requireApiKey(config);

  // Guard the target before any write.
  const service = await api<any>(config, { method: 'GET', path: `/services/${serviceId}`, apiKey });
  const assignee = (service?.participants ?? []).find((p: any) => p?.role === 'assignee')?.tenantKey;
  if (expectAssignee && assignee !== expectAssignee) {
    throw new Error(
      `Service ${serviceId} has assignee "${assignee ?? 'none'}", not "${expectAssignee}". No asset was declared or linked.`,
    );
  }

  const catalog = await api<any>(config, { method: 'GET', path: '/catalog/asset-types', apiKey });
  const typeNames = new Map<string, string>(
    (catalog?.asset_types ?? []).map((t: any) => [String(t.code), String(t.name ?? t.code)]),
  );
  for (const spec of specs) {
    if (!typeNames.has(spec.type)) {
      throw new Error(`Asset type "${spec.type}" is not in GET /catalog/asset-types.`);
    }
  }

  const declared: {
    spec: (typeof specs)[number];
    role: ManifestRole;
    assetId: number | null;
    created: boolean;
    source: string;
    planned?: unknown;
  }[] = [];
  for (const [index, spec] of specs.entries()) {
    const name = names[index] ?? `${typeNames.get(spec.type)} ${spec.refId}`;
    const role = (roleFlag as ManifestRole | undefined) ?? defaultManifestRole(spec.type);
    const result = await declareAsset(config, { apiKey, spec, name, dryRun });
    if ('planned' in result) {
      declared.push({ spec, role, assetId: null, created: false, source: 'dry-run', planned: result.planned });
    } else {
      declared.push({ spec, role, assetId: result.asset.id, created: result.created, source: result.source });
    }
  }

  const known = declared.filter((d) => d.assetId !== null);
  const link = await linkServiceAssets(config, {
    apiKey,
    serviceId,
    entries: known.map((d) => ({ assetId: d.assetId as number, role: d.role })),
    dryRun,
  });

  const summary = {
    serviceId,
    assignee: assignee ?? null,
    dryRun,
    assets: declared.map((d) => ({
      type: d.spec.type,
      refType: d.spec.refType,
      refId: d.spec.refId,
      assetId: d.assetId,
      role: d.role,
      created: d.created,
      source: d.source,
      ...(d.planned ? { planned: d.planned } : {}),
    })),
    linksAdded: link.added,
    linksAlreadyPresent: link.alreadyLinked,
    manifest: link.manifest.map(({ assetId, role }) => ({ assetId, role })),
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  heading(dryRun ? 'Asset linking plan (dry run, nothing written)' : 'Service assets linked');
  kv('serviceId', serviceId);
  kv('assignee', assignee ?? '—');
  for (const a of summary.assets) {
    kv('asset', `${a.type} ${a.refType}=${a.refId} → id ${a.assetId ?? '(would create)'} [${a.source}] role ${a.role}`);
  }
  kv('linksAdded', link.added.length);
  kv('linksAlreadyPresent', link.alreadyLinked.length);
  console.log('\nRESULT ' + JSON.stringify(summary));
});
