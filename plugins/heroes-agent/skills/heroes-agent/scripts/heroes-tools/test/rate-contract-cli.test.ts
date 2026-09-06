import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { approveRateCard, computeHeroesCatalogHash, type HeroesRateCatalog, type RateCard } from '../rate-contract';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(toolsDir, '..', '..', '..', '..');
const launcher = join(pluginRoot, 'scripts', 'run-tool.mjs');

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

function runTool(
  workspace: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveProcess) => {
    const child = spawn(process.execPath, [launcher, ...args], {
      cwd: workspace,
      env: {
        ...process.env,
        API_URL: 'http://127.0.0.1:1/api',
        API_KEY: 'wrong-inherited-key',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolveProcess({ code, stdout, stderr }));
  });
}

const catalogVocabulary = {
  openApiVersion: '0.1.test',
  locationRoles: [
    'origin', 'destination', 'port_of_loading', 'port_of_discharge', 'transshipment', 'depot', 'warehouse',
  ],
  timeframeKinds: [
    'validity', 'departure_window', 'arrival_deadline', 'cargo_ready', 'customs_clearance_by',
  ],
  participantRoles: ['assigner', 'assignee', 'observer', 'issuer', 'recipient'],
  strategies: [{ strategyKey: 'OFFER', steps: ['PUBLISHED'] }],
};

function writeHeroesCatalog(path: string, value: Omit<HeroesRateCatalog, 'responseHash'>): string {
  const catalog = { ...value, responseHash: '' } as HeroesRateCatalog;
  catalog.responseHash = computeHeroesCatalogHash(catalog);
  writeFileSync(path, JSON.stringify(catalog));
  return catalog.responseHash;
}

function sealedCard<T extends RateCard>(card: T): T {
  approveRateCard(card, card.approval.approvedBy, card.approval.approvedAt);
  return card;
}

test('operator snapshots Heroes rate catalogs through the current peer credential path', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-catalog-'));
  const requests: { url?: string; apiKey?: string }[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    requests.push({ url: request.url, apiKey: request.headers['x-api-key'] as string | undefined });
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/openapi') {
      response.end(JSON.stringify({
        info: { version: '0.1.test' },
        paths: { '/api/offers/search': { post: { requestBody: { content: { 'application/json': { schema: {
          properties: {
            // Deliberately stale and wrong: the snapshot must take its location roles
            // from the catalog read, never from this document again.
            locodes: { items: { properties: { role: { enum: ['scraped-role'] } } } },
            participants: { items: { properties: { role: { enum: ['assigner', 'assignee'] } } } },
          },
        } } } } } } },
      }));
    } else if (request.url === '/api/catalog/location-roles') {
      response.end(JSON.stringify({ data: { location_roles: [
        { code: 'origin', name: 'Origin', description: 'Start of the whole service' },
        { code: 'port_of_loading', name: 'Port of loading', description: 'Main leg load port' },
        { code: 'port_of_discharge', name: 'Port of discharge', description: 'Main leg discharge port' },
        { code: 'destination', name: 'Destination', description: 'End of the whole service' },
      ] } }));
    } else if (request.url === '/api/catalog/timeframe-kinds') {
      response.end(JSON.stringify({ data: { timeframe_kinds: [
        { code: 'validity', name: 'Validity', description: 'Offer validity window' },
        { code: 'departure_window', name: 'Departure window', description: 'Planned departure' },
      ] } }));
    } else if (request.url === '/api/catalog/services') {
      response.end(JSON.stringify({ data: [{ serviceKey: 'fcl_freight_forwarding' }, { serviceKey: 'airfreight' }] }));
    } else if (request.url === '/api/catalog/asset-types') {
      response.end(JSON.stringify({ data: { asset_types: [{ code: 'container', name: 'Container', description: null }] } }));
    } else if (request.url === '/api/catalog/asset-subtypes?asset_type=container') {
      response.end(JSON.stringify({ data: { asset_subtypes: [{ subtype: '40HC', code: null, codeType: null, description: null }] } }));
    } else if (request.url === '/api/strategies/templates') {
      response.end(JSON.stringify({ data: { templates: [{ key: 'RFQ', steps: [{ key: 'QUOTED' }] }] } }));
    } else {
      response.writeHead(404).end();
    }
  });

  try {
    const port = await listen(server);
    mkdirSync(join(workspace, 'self'));
    writeFileSync(
      join(workspace, 'self', '.env'),
      `API_URL=http://127.0.0.1:${port}/api\nAPI_KEY=workspace-key\n`,
      { mode: 0o600 },
    );
    const output = join(workspace, 'catalog.json');
    writeFileSync(output, JSON.stringify({ responseHash: '0'.repeat(64) }));
    const result = await runTool(workspace, ['sync-rate-catalog.ts', '--output', output]);

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.deepEqual(requests, [
      { url: '/openapi', apiKey: undefined },
      { url: '/api/catalog/services', apiKey: 'workspace-key' },
      { url: '/api/catalog/asset-types', apiKey: 'workspace-key' },
      { url: '/api/strategies/templates', apiKey: 'workspace-key' },
      { url: '/api/catalog/location-roles', apiKey: 'workspace-key' },
      { url: '/api/catalog/timeframe-kinds', apiKey: 'workspace-key' },
      { url: '/api/catalog/asset-subtypes?asset_type=container', apiKey: 'workspace-key' },
    ]);
    const snapshot = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(snapshot.schemaVersion, '1.0');
    assert.deepEqual(snapshot.services.map((service: { serviceKey: string }) => service.serviceKey), [
      'airfreight',
      'fcl_freight_forwarding',
    ]);
    assert.deepEqual(snapshot.assetTypes, [{ code: 'container' }]);
    assert.deepEqual(snapshot.assetSubtypes, [{ assetType: 'container', subtype: '40HC' }]);
    assert.equal(snapshot.openApiVersion, '0.1.test');
    assert.deepEqual(snapshot.locationRoles, [
      'destination', 'origin', 'port_of_discharge', 'port_of_loading',
    ]);
    assert.deepEqual(snapshot.timeframeKinds, ['departure_window', 'validity']);
    assert.doesNotMatch(readFileSync(output, 'utf8'), /scraped-role/);
    assert.deepEqual(snapshot.participantRoles, ['assignee', 'assigner']);
    assert.deepEqual(snapshot.strategies, [{ strategyKey: 'RFQ', steps: ['QUOTED'] }]);
    assert.match(snapshot.responseHash, /^[a-f0-9]{64}$/);
    assert.match(result.stdout, /catalog changed; re-import and re-approve affected cards/);
    assert.doesNotMatch(readFileSync(output, 'utf8') + result.stdout + result.stderr, /workspace-key|wrong-inherited-key/);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('rate import completes an interrupted archive transaction on the next run', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-recovery-'));
  try {
    const inbox = join(workspace, 'inbox');
    const processed = join(workspace, 'processed');
    mkdirSync(inbox);
    mkdirSync(processed);
    const file = 'pending.csv';
    writeFileSync(join(inbox, file), 'already committed source');
    const indexPath = join(workspace, 'rate-catalog.json');
    writeFileSync(indexPath, JSON.stringify({ schemaVersion: '1.0', rateCards: [] }));
    writeFileSync(`${indexPath}.transaction.json`, JSON.stringify({ inbox, processedDir: processed, files: [file] }));
    const catalogPath = join(workspace, 'heroes-catalog.json');
    writeHeroesCatalog(catalogPath, {
      schemaVersion: '1.0', fetchedAt: '2026-08-13T00:00:00Z', ...catalogVocabulary,
      services: [{ serviceKey: 'fcl_freight_forwarding' }], assetTypes: [{ code: 'container' }],
      assetSubtypes: [
        { assetType: 'container', subtype: '40HC' },
        { assetType: 'container', subtype: '40DC' },
      ],
    });

    const preview = await runTool(workspace, [
      'ingest-rates.ts', inbox, '--catalog', catalogPath, '--index', indexPath,
      '--processed', processed, '--dry-run',
    ]);
    assert.equal(preview.code, 1, preview.stdout + preview.stderr);
    assert.equal(existsSync(join(inbox, file)), true);
    assert.equal(existsSync(`${indexPath}.transaction.json`), true);

    const result = await runTool(workspace, [
      'ingest-rates.ts', inbox, '--catalog', catalogPath, '--index', indexPath, '--processed', processed,
    ]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(existsSync(join(processed, file)), true);
    assert.equal(existsSync(`${indexPath}.transaction.json`), false);

    writeFileSync(`${indexPath}.next`, 'orphan stage');
    const orphanRecovery = await runTool(workspace, [
      'ingest-rates.ts', inbox, '--catalog', catalogPath, '--index', indexPath, '--processed', processed,
    ]);
    assert.equal(orphanRecovery.code, 0, orphanRecovery.stderr || orphanRecovery.stdout);
    assert.equal(existsSync(`${indexPath}.next`), false);

    for (const phase of ['staged', 'committed'] as const) {
      const missingFile = `${phase}-missing.csv`;
      if (phase === 'staged') writeFileSync(`${indexPath}.next`, 'recoverable stage');
      writeFileSync(`${indexPath}.transaction.json`, JSON.stringify({
        inbox, processedDir: processed, files: [missingFile], phase,
      }));
      const missingRecovery = await runTool(workspace, [
        'ingest-rates.ts', inbox, '--catalog', catalogPath, '--index', indexPath, '--processed', processed,
      ]);
      assert.equal(missingRecovery.code, 0, missingRecovery.stderr || missingRecovery.stdout);
      assert.equal(existsSync(`${indexPath}.transaction.json`), false);
      assert.equal(existsSync(`${indexPath}.next`), false);
    }

    writeFileSync(`${indexPath}.next`, 'preparing stage');
    writeFileSync(`${indexPath}.transaction.json`, JSON.stringify({
      inbox, processedDir: processed, files: [], phase: 'preparing',
    }));
    const preparingRecovery = await runTool(workspace, [
      'ingest-rates.ts', inbox, '--catalog', catalogPath, '--index', indexPath, '--processed', processed,
    ]);
    assert.equal(preparingRecovery.code, 0, preparingRecovery.stderr || preparingRecovery.stdout);
    assert.equal(existsSync(`${indexPath}.next`), false);

    for (const phase of ['staged', 'committed'] as const) {
      const phaseFile = `${phase}.csv`;
      writeFileSync(join(inbox, phaseFile), `${phase} source`);
      writeFileSync(`${indexPath}.transaction.json`, JSON.stringify({
        inbox, processedDir: processed, files: [phaseFile], phase,
      }));
      const phaseRecovery = await runTool(workspace, [
        'ingest-rates.ts', inbox, '--catalog', catalogPath, '--index', indexPath, '--processed', processed,
      ]);
      assert.equal(phaseRecovery.code, 0, phaseRecovery.stderr || phaseRecovery.stdout);
      assert.equal(existsSync(join(processed, phaseFile)), true);
      assert.equal(existsSync(`${indexPath}.transaction.json`), false);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('stale approved cards do not block discovery or a new rate import', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-stale-'));
  try {
    const catalogPath = join(workspace, 'heroes-catalog.json');
    const currentHash = writeHeroesCatalog(catalogPath, {
      schemaVersion: '1.0', fetchedAt: '2026-08-13T00:00:00Z', ...catalogVocabulary,
      services: [{ serviceKey: 'fcl_freight_forwarding' }], assetTypes: [{ code: 'container' }],
      assetSubtypes: [{ assetType: 'container', subtype: '40HC' }],
    });
    const staleCard = sealedCard({
      id: 'stale-card', journeyType: 'OFFER',
      rules: [{
        id: 'stale-rule', serviceKey: 'fcl_freight_forwarding',
        locodes: [{ code: 'NLRTM', role: 'origin' }], timeframes: [],
        assetTypes: [{ type: 'container', subtypes: ['40HC'] }], participants: [], strategy: null,
        charges: [{ chargeKey: 'freight', amount: '100', currency: 'USD', basis: 'container' }], conditions: [],
      }],
      sourceEvidence: [{ sourceFile: 'stale.csv', sourceRef: 'OLD', sourceHash: 'a'.repeat(64) }],
      approval: { status: 'approved', approvedBy: 'operator', approvedAt: '2026-08-12T00:00:00Z' },
      catalogReference: { responseHash: 'b'.repeat(64), fetchedAt: '2026-08-12T00:00:00Z' },
    } as RateCard);
    const indexPath = join(workspace, 'rate-catalog.json');
    writeFileSync(indexPath, JSON.stringify({ schemaVersion: '1.0', rateCards: [staleCard] }));

    const discovery = await runTool(workspace, [
      'find-rate.ts', '--service-key', 'fcl_freight_forwarding', '--origin', 'NLRTM',
      '--asset-type', 'container', '--asset-subtype', '40HC',
      '--index', indexPath, '--catalog', catalogPath, '--json',
    ]);
    assert.equal(discovery.code, 3, discovery.stderr || discovery.stdout);
    assert.equal(JSON.parse(discovery.stdout).status, 'none');

    const inbox = join(workspace, 'inbox');
    mkdirSync(inbox);
    writeFileSync(join(inbox, 'new.csv'), [
      'cardId,ruleId,serviceKey,origin,assetType,assetSubtype,chargeKey,amount,currency,basis,sourceRef,approvalStatus,approvedBy,approvedAt',
      'current-card,current-rule,fcl_freight_forwarding,NLRTM,container,40HC,freight,120,USD,container,NEW,draft,,,',
    ].join('\n'));
    const imported = await runTool(workspace, [
      'ingest-rates.ts', inbox, '--catalog', catalogPath, '--index', indexPath,
      '--processed', join(workspace, 'processed'),
    ]);
    assert.equal(imported.code, 0, imported.stderr || imported.stdout);
    assert.match(imported.stdout, /stale cards\s+1; re-approve before use/);
    const cards = JSON.parse(readFileSync(indexPath, 'utf8')).rateCards;
    assert.deepEqual(cards.map((card: { id: string }) => card.id), ['current-card', 'stale-card']);
    assert.equal(cards[0].catalogReference.responseHash, currentHash);

    const draftOnly = await runTool(workspace, [
      'find-rate.ts', '--service-key', 'fcl_freight_forwarding', '--origin', 'NLRTM',
      '--asset-type', 'container', '--asset-subtype', '40HC',
      '--index', indexPath, '--catalog', catalogPath, '--json',
    ]);
    assert.equal(draftOnly.code, 3, draftOnly.stderr || draftOnly.stdout);
    assert.equal(JSON.parse(draftOnly.stdout).status, 'none');
    assert.match(JSON.parse(draftOnly.stdout).reason, /no complete approved current valid rate rule applies/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('operator imports diverse CSV rates into one versioned Heroes-shaped catalog', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-import-'));
  try {
    const inbox = join(workspace, 'self', 'rate-book', 'inbox');
    mkdirSync(inbox, { recursive: true });
    const catalogPath = join(workspace, 'heroes-catalog.json');
    const responseHash = writeHeroesCatalog(catalogPath, {
      schemaVersion: '1.0',
      fetchedAt: '2026-08-13T00:00:00Z',
      ...catalogVocabulary,
      services: [
        'fcl_freight_forwarding', 'freight_forwarding', 'airfreight',
        'ltl_pickup_origin', 'import_fcl_forwarding', 'intrahouse_handling',
      ].map((serviceKey) => ({ serviceKey })),
      assetTypes: [
        'container', 'cargo', 'mawb', 'truck', 'port_order', 'pallet',
      ].map((code) => ({ code })),
      assetSubtypes: [{ assetType: 'container', subtype: '40HC' }],
    });
    writeFileSync(
      join(inbox, 'diverse-rates.csv'),
      [
        'cardId,ruleId,serviceKey,origin,destination,locationCode,locationRole,assetType,assetSubtype,validFrom,validTo,chargeKey,amount,currency,basis,sourceRef,approvalStatus,approvedBy,approvedAt',
        'fcl-1,fcl-rule,fcl_freight_forwarding,NLRTM,USNYC,,,container,40HC,2026-08-01,2026-12-31,ocean-freight,8000,USD,container,FCL-1,draft,,,',
        'lcl-1,lcl-rule,freight_forwarding,NLRTM,SGSIN,,,cargo,,2026-08-01,2026-12-31,ocean-freight,90,USD,cbm,LCL-1,draft,,,',
        'air-1,air-rule,airfreight,DEHAM,USJFK,,,mawb,,2026-08-01,2026-12-31,air-freight,4.5,EUR,chargeable-kg,AIR-1,draft,,,',
        'road-1,road-rule,ltl_pickup_origin,DEHAM,DEBER,,,truck,,2026-08-01,2026-12-31,linehaul,900,EUR,shipment,ROAD-1,draft,,,',
        'customs-1,customs-rule,import_fcl_forwarding,,,,,,,2026-08-01,2026-12-31,customs-clearance,75,EUR,customs-entry,CUSTOMS-1,draft,,,',
        'storage-1,storage-rule,intrahouse_handling,,,DEHAM,warehouse,pallet,,2026-08-01,2026-12-31,storage,12,EUR,pallet-day,STORAGE-1,draft,,,',
      ].join('\n') + '\n',
    );
    const indexPath = join(workspace, 'rate-catalog.json');
    const processed = join(workspace, 'processed');
    const result = await runTool(workspace, [
      'ingest-rates.ts', inbox, '--catalog', catalogPath, '--index', indexPath,
      '--processed', processed, '--approve-by', 'operator',
    ]);

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const rateCatalog = JSON.parse(readFileSync(indexPath, 'utf8'));
    assert.equal(rateCatalog.schemaVersion, '1.0');
    assert.equal(rateCatalog.rateCards.length, 6);
    assert.deepEqual(
      rateCatalog.rateCards.map((card: { rules: { serviceKey: string }[] }) => card.rules[0].serviceKey).sort(),
      ['airfreight', 'fcl_freight_forwarding', 'freight_forwarding', 'import_fcl_forwarding', 'intrahouse_handling', 'ltl_pickup_origin'],
    );
    const fcl = rateCatalog.rateCards.find((card: { id: string }) => card.id === 'fcl-1');
    assert.deepEqual(fcl.rules[0].locodes, [
      { code: 'NLRTM', role: 'origin' }, { code: 'USNYC', role: 'destination' },
    ]);
    assert.deepEqual(fcl.rules[0].assetTypes, [{ type: 'container', subtypes: ['40HC'] }]);
    assert.deepEqual(fcl.rules[0].charges, [{ chargeKey: 'ocean-freight', amount: '8000', currency: 'USD', basis: 'container' }]);
    assert.equal(fcl.sourceEvidence[0].sourceFile, 'diverse-rates.csv');
    assert.match(fcl.sourceEvidence[0].sourceHash, /^[a-f0-9]{64}$/);
    assert.equal(fcl.catalogReference.responseHash, responseHash);
    assert.equal(fcl.approval.status, 'approved');

    const queries = [
      ['fcl_freight_forwarding', '--origin', 'NLRTM', '--dest', 'USNYC', '--asset-type', 'container', '--asset-subtype', '40HC'],
      ['freight_forwarding', '--origin', 'NLRTM', '--dest', 'SGSIN', '--asset-type', 'cargo'],
      ['airfreight', '--origin', 'DEHAM', '--dest', 'USJFK', '--asset-type', 'mawb'],
      ['ltl_pickup_origin', '--origin', 'DEHAM', '--dest', 'DEBER', '--asset-type', 'truck'],
      [
        'import_fcl_forwarding', '--asset', 'truck', '--location', 'DEHAM:depot',
        '--participant', 'other:assignee', '--strategy', 'OFFER', '--strategy-step', 'PUBLISHED',
      ],
      ['intrahouse_handling', '--location', 'DEHAM:warehouse', '--asset-type', 'pallet'],
    ];
    for (const [serviceKey, ...queryArgs] of queries) {
      const discovery = await runTool(workspace, [
        'find-rate.ts', '--service-key', serviceKey, ...queryArgs, '--date', '2026-09-01',
        '--index', indexPath, '--catalog', catalogPath, '--json',
      ]);
      assert.equal(discovery.code, 0, discovery.stderr || discovery.stdout);
      const parsed = JSON.parse(discovery.stdout);
      assert.equal(parsed.status, 'matched');
      assert.equal(parsed.rate.rule.serviceKey, serviceKey);
    }
    for (const mismatchArgs of [
      ['--origin', 'NLRTM', '--dest', 'DEHAM', '--asset-type', 'container', '--asset-subtype', '40HC'],
      ['--origin', 'NLRTM', '--dest', 'USNYC', '--asset-type', 'truck'],
      ['--origin', 'NLRTM', '--dest', 'USNYC', '--asset-type', 'container', '--asset-subtype', '40HC', '--date', '2027-01-01'],
    ]) {
      const mismatch = await runTool(workspace, [
        'find-rate.ts', '--service-key', 'fcl_freight_forwarding', ...mismatchArgs,
        '--index', indexPath, '--catalog', catalogPath, '--json',
      ]);
      assert.equal(mismatch.code, 3, mismatch.stderr || mismatch.stdout);
      assert.equal(JSON.parse(mismatch.stdout).status, 'none');
    }
    const invalidQuery = await runTool(workspace, [
      'find-rate.ts', '--service-key', 'fcl_freight_forwarding', '--location', 'NLRTM:invented',
      '--date', '2026-99-01', '--asset-type', 'container', '--asset-subtype', '40HC',
      '--index', indexPath, '--catalog', catalogPath, '--json',
    ]);
    assert.equal(invalidQuery.code, 4, invalidQuery.stderr || invalidQuery.stdout);
    assert.match(JSON.parse(invalidQuery.stdout).reason, /unknown Heroes location role invented/);
    assert.match(JSON.parse(invalidQuery.stdout).reason, /invalid timeframe from 2026-99-01/);
    const orphanSubtype = await runTool(workspace, [
      'find-rate.ts', '--service-key', 'fcl_freight_forwarding', '--origin', 'NLRTM',
      '--asset-subtype', '40HC', '--index', indexPath, '--catalog', catalogPath, '--json',
    ]);
    assert.equal(orphanSubtype.code, 4, orphanSubtype.stderr || orphanSubtype.stdout);
    assert.match(JSON.parse(orphanSubtype.stdout).reason, /--asset-subtype requires --asset-type/);

    const conflictInbox = join(workspace, 'conflict-inbox');
    mkdirSync(conflictInbox);
    writeFileSync(join(conflictInbox, 'conflict.csv'), [
      'cardId,ruleId,serviceKey,origin,destination,assetType,chargeKey,amount,currency,basis,sourceRef,approvalStatus,approvedBy,approvedAt',
      'conflict-card,conflict-rule,fcl_freight_forwarding,NLRTM,USNYC,container,freight,10,USD,container,REF-A,draft,,',
      'conflict-card,conflict-rule,fcl_freight_forwarding,NLRTM,USNYC,container,documentation,1,USD,document,REF-B,draft,,',
    ].join('\n'));
    const conflict = await runTool(workspace, [
      'ingest-rates.ts', conflictInbox, '--catalog', catalogPath, '--index', indexPath,
      '--processed', processed,
    ]);
    assert.equal(conflict.code, 1, conflict.stdout + conflict.stderr);
    assert.match(conflict.stderr, /conflicting source evidence/);

    const collisionInbox = join(workspace, 'collision-inbox');
    mkdirSync(collisionInbox);
    const collisionName = 'collision.csv';
    writeFileSync(join(collisionInbox, collisionName), [
      'cardId,ruleId,serviceKey,origin,destination,assetType,chargeKey,amount,currency,basis,sourceRef,approvalStatus,approvedBy,approvedAt',
      'collision-card,collision-rule,fcl_freight_forwarding,NLRTM,USNYC,container,freight,10,USD,container,REF-C,draft,,',
    ].join('\n'));
    writeFileSync(join(processed, collisionName), 'existing evidence');
    const beforeCollision = readFileSync(indexPath, 'utf8');
    const collision = await runTool(workspace, [
      'ingest-rates.ts', collisionInbox, '--catalog', catalogPath, '--index', indexPath,
      '--processed', processed,
    ]);
    assert.equal(collision.code, 1, collision.stdout + collision.stderr);
    assert.match(collision.stderr, /Processed file already exists/);
    assert.equal(readFileSync(indexPath, 'utf8'), beforeCollision);
    assert.equal(existsSync(join(collisionInbox, collisionName)), true);

    const tampered = JSON.parse(readFileSync(catalogPath, 'utf8'));
    tampered.services.push({ serviceKey: 'invented-service' });
    writeFileSync(catalogPath, JSON.stringify(tampered));
    const tamperedResult = await runTool(workspace, [
      'find-rate.ts', '--service-key', 'fcl_freight_forwarding', '--origin', 'NLRTM',
      '--index', indexPath, '--catalog', catalogPath, '--json',
    ]);
    assert.equal(tamperedResult.code, 4, tamperedResult.stderr || tamperedResult.stdout);
    assert.match(JSON.parse(tamperedResult.stdout).reason, /response hash does not match/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('rate discovery blocks two approved applicable rules instead of choosing the cheapest', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-find-'));
  try {
    const catalogPath = join(workspace, 'heroes-catalog.json');
    const responseHash = writeHeroesCatalog(catalogPath, {
      schemaVersion: '1.0', fetchedAt: '2026-08-13T00:00:00Z',
      ...catalogVocabulary,
      services: [{ serviceKey: 'fcl_freight_forwarding' }],
      assetTypes: [{ code: 'container' }],
      assetSubtypes: [{ assetType: 'container', subtype: '40HC' }],
    });
    const rule = (id: string, amount: string) => ({
      id: `${id}-rule`, serviceKey: 'fcl_freight_forwarding',
      locodes: [{ code: 'NLRTM', role: 'origin' }, { code: 'USNYC', role: 'destination' }],
      timeframes: [{ from: '2026-08-01', to: '2026-12-31' }],
      assetTypes: [{ type: 'container', subtypes: ['40HC'] }],
      participants: [], strategy: null,
      charges: [{ chargeKey: 'ocean-freight', amount, currency: 'USD', basis: 'container' }],
      conditions: [],
    });
    const card = (id: string, amount: string) => sealedCard({
      id, journeyType: 'OFFER', rules: [rule(id, amount)],
      sourceEvidence: [{ sourceFile: `${id}.csv`, sourceRef: id, sourceHash: 'c'.repeat(64) }],
      approval: { status: 'approved', approvedBy: 'operator', approvedAt: '2026-08-13T00:00:00Z' },
      catalogReference: { responseHash, fetchedAt: '2026-08-13T00:00:00Z' },
    } as RateCard);
    const indexPath = join(workspace, 'rate-catalog.json');
    writeFileSync(indexPath, JSON.stringify({ schemaVersion: '1.0', rateCards: [card('filed-a', '8000'), card('filed-b', '7900')] }));

    const result = await runTool(workspace, [
      'find-rate.ts', '--service-key', 'fcl_freight_forwarding', '--origin', 'NLRTM', '--dest', 'USNYC',
      '--asset-type', 'container', '--asset-subtype', '40HC', '--date', '2026-09-01',
      '--index', indexPath, '--catalog', catalogPath, '--json',
    ]);

    assert.equal(result.code, 3, result.stderr || result.stdout);
    const discovery = JSON.parse(result.stdout);
    assert.equal(discovery.status, 'ambiguous');
    assert.equal(discovery.match, false);
    assert.equal(discovery.candidates.length, 2);
    assert.equal(discovery.best, undefined);
    assert.match(discovery.reason, /two complete approved current valid rate rules apply/i);

    const conditional = card('filed-b', '7900');
    conditional.rules[0].participants = [{ tenantKey: 'carrier-a', role: 'assignee' }];
    approveRateCard(conditional, 'operator', '2026-08-13T00:00:00Z');
    writeFileSync(indexPath, JSON.stringify({
      schemaVersion: '1.0', rateCards: [card('filed-a', '8000'), conditional],
    }));
    const unresolved = await runTool(workspace, [
      'find-rate.ts', '--service-key', 'fcl_freight_forwarding',
      '--origin', 'NLRTM', '--dest', 'USNYC', '--asset-type', 'container',
      '--asset-subtype', '40HC', '--date', '2026-09-01',
      '--index', indexPath, '--catalog', catalogPath, '--json',
    ]);
    assert.equal(unresolved.code, 3, unresolved.stderr || unresolved.stdout);
    assert.equal(JSON.parse(unresolved.stdout).status, 'incomplete');
    assert.match(JSON.parse(unresolved.stdout).reason, /participant carrier-a:assignee/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('rate import rejects a CSV with no rate rows and keeps its source recoverable', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-empty-import-'));
  try {
    const catalogPath = join(workspace, 'heroes-catalog.json');
    writeHeroesCatalog(catalogPath, {
      schemaVersion: '1.0', fetchedAt: '2026-08-13T00:00:00Z',
      ...catalogVocabulary,
      services: [{ serviceKey: 'fcl_freight_forwarding' }],
      assetTypes: [{ code: 'container' }],
      assetSubtypes: [{ assetType: 'container', subtype: '40HC' }],
    });
    const inbox = join(workspace, 'inbox');
    const processed = join(workspace, 'processed');
    const indexPath = join(workspace, 'rate-catalog.json');
    mkdirSync(inbox);
    const source = join(inbox, 'header-only.csv');
    writeFileSync(
      source,
      'cardId,ruleId,serviceKey,origin,destination,assetType,chargeKey,amount,currency,basis,sourceRef,approvalStatus,approvedBy,approvedAt\n',
    );

    const result = await runTool(workspace, [
      'ingest-rates.ts', inbox, '--catalog', catalogPath, '--index', indexPath,
      '--processed', processed,
    ]);

    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /no rate rows/i);
    assert.equal(existsSync(source), true);
    assert.equal(existsSync(indexPath), false);
    assert.equal(existsSync(join(processed, 'header-only.csv')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('rate import dry-run writes nothing and duplicate retries keep their source recoverable', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-dry-run-'));
  try {
    const catalogPath = join(workspace, 'heroes-catalog.json');
    writeHeroesCatalog(catalogPath, {
      schemaVersion: '1.0', fetchedAt: '2026-08-13T00:00:00Z',
      ...catalogVocabulary,
      services: [{ serviceKey: 'fcl_freight_forwarding' }],
      assetTypes: [{ code: 'container' }],
      assetSubtypes: [{ assetType: 'container', subtype: '40HC' }],
    });
    const inbox = join(workspace, 'inbox');
    const processed = join(workspace, 'processed');
    const indexPath = join(workspace, 'rate-catalog.json');
    mkdirSync(inbox);
    const source = join(inbox, 'rates.csv');
    const csv = [
      'cardId,ruleId,serviceKey,origin,destination,assetType,assetSubtype,validFrom,validTo,chargeKey,amount,currency,basis,sourceRef,approvalStatus,approvedBy,approvedAt',
      'card-1,rule-1,fcl_freight_forwarding,NLRTM,USNYC,container,40HC,2026-08-01,2026-12-31,freight,8000,USD,container,REF-1,draft,,,',
    ].join('\n');
    writeFileSync(source, csv);

    const dryRun = await runTool(workspace, [
      'ingest-rates.ts', inbox, '--catalog', catalogPath, '--index', indexPath,
      '--processed', processed, '--dry-run',
    ]);
    assert.equal(dryRun.code, 0, dryRun.stderr || dryRun.stdout);
    assert.equal(existsSync(source), true);
    assert.equal(existsSync(indexPath), false);
    assert.equal(existsSync(processed), false);

    const ingest = await runTool(workspace, [
      'ingest-rates.ts', inbox, '--catalog', catalogPath, '--index', indexPath,
      '--processed', processed,
    ]);
    assert.equal(ingest.code, 0, ingest.stderr || ingest.stdout);
    assert.equal(existsSync(source), false);
    assert.equal(existsSync(join(processed, 'rates.csv')), true);
    assert.equal(JSON.parse(readFileSync(indexPath, 'utf8')).rateCards.length, 1);

    writeFileSync(source, csv);
    const duplicate = await runTool(workspace, [
      'ingest-rates.ts', inbox, '--catalog', catalogPath, '--index', indexPath,
      '--processed', processed,
    ]);
    assert.equal(duplicate.code, 1, duplicate.stdout + duplicate.stderr);
    assert.match(duplicate.stderr, /Duplicate rate card id/);
    assert.equal(existsSync(source), true);
    assert.equal(JSON.parse(readFileSync(indexPath, 'utf8')).rateCards.length, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('rate discovery returns exit 2 when its configured store is missing', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-no-store-'));
  try {
    const result = await runTool(workspace, [
      'find-rate.ts', '--service-key', 'fcl_freight_forwarding',
      '--index', join(workspace, 'missing-rate-catalog.json'),
      '--catalog', join(workspace, 'missing-heroes-catalog.json'), '--json',
    ]);

    assert.equal(result.code, 2, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).match, false);
    assert.match(JSON.parse(result.stdout).reason, /rate index and Heroes catalog are required/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('rate discovery returns invalid exit 4 for malformed canonical JSON', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-malformed-'));
  try {
    const catalogPath = join(workspace, 'heroes-catalog.json');
    writeHeroesCatalog(catalogPath, {
      schemaVersion: '1.0', fetchedAt: '2026-08-13T00:00:00Z',
      openApiVersion: '0.1.test', services: [{ serviceKey: 'fcl_freight_forwarding' }],
      assetTypes: [{ code: 'container' }], assetSubtypes: [],
      locationRoles: ['origin'], timeframeKinds: ['validity'], participantRoles: ['assigner'],
      strategies: [],
    });
    const indexPath = join(workspace, 'rate-catalog.json');
    writeFileSync(indexPath, JSON.stringify({ schemaVersion: '1.0' }));
    const result = await runTool(workspace, [
      'find-rate.ts', '--service-key', 'fcl_freight_forwarding', '--origin', 'NLRTM',
      '--index', indexPath, '--catalog', catalogPath, '--json',
    ]);
    assert.equal(result.code, 4, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).status, 'invalid');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('rate discovery rejects unknown Heroes values and invalid charge expressions', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-invalid-'));
  try {
    const catalogPath = join(workspace, 'heroes-catalog.json');
    const responseHash = writeHeroesCatalog(catalogPath, {
      schemaVersion: '1.0', fetchedAt: '2026-08-13T00:00:00Z',
      ...catalogVocabulary,
      services: [{ serviceKey: 'fcl_freight_forwarding' }],
      assetTypes: [{ code: 'container' }, { code: 'truck' }],
      assetSubtypes: [{ assetType: 'container', subtype: '40HC' }],
    });
    const indexPath = join(workspace, 'rate-catalog.json');
    writeFileSync(indexPath, JSON.stringify({
      schemaVersion: '1.0',
      rateCards: [{
        id: 'invalid-card',
        journeyType: 'OFFER',
        rules: [{
          id: 'invalid-rule', serviceKey: 'invented_service',
          locodes: [{ code: 'NLRTM', role: 'origin' }],
          timeframes: [{ from: '2026-13-01', to: '2026-01-01' }],
          assetTypes: [{ type: 'container', subtypes: ['40HC'] }], participants: [],
          strategy: { strategyKey: 'INVENTED', currentStep: 'UNKNOWN' },
          charges: [
            {
              chargeKey: 'freight', amount: '-1', currency: 'US', basis: '',
              tiers: [{ upTo: null, amount: '1' }],
            },
            { chargeKey: 'freight', amount: '1', currency: 'USD', basis: 'shipment' },
          ],
          conditions: [],
        }],
        sourceEvidence: [{ sourceFile: '', sourceRef: '', sourceHash: 'invalid' }],
        approval: { status: 'released', approvedBy: '', approvedAt: '' },
        catalogReference: { responseHash, fetchedAt: '2026-08-13T00:00:00Z' },
      }],
    }));

    const result = await runTool(workspace, [
      'find-rate.ts', '--service-key', 'invented_service', '--origin', 'NLRTM',
      '--index', indexPath, '--catalog', catalogPath, '--json',
    ]);

    assert.equal(result.code, 4, result.stderr || result.stdout);
    const discovery = JSON.parse(result.stdout);
    assert.equal(discovery.status, 'invalid');
    assert.match(discovery.reason, /unknown Heroes serviceKey invented_service/);
    assert.match(discovery.reason, /amount must be a positive decimal/);
    assert.match(discovery.reason, /currency must be an ISO 4217 code/);
    assert.match(discovery.reason, /basis is required/);
    assert.match(discovery.reason, /unknown Heroes strategy INVENTED/);
    assert.match(discovery.reason, /exactly one of amount or tiers is required/);
    assert.match(discovery.reason, /duplicate chargeKey freight/);
    assert.match(discovery.reason, /invalid timeframe date/);
    assert.match(discovery.reason, /sourceFile is required/);
    assert.match(discovery.reason, /sourceHash must be a SHA-256 hash/);
    assert.match(discovery.reason, /approval status must be draft or approved/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('rate discovery reports required offer facts instead of treating a partial query as complete', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-incomplete-'));
  try {
    const catalogPath = join(workspace, 'heroes-catalog.json');
    const responseHash = writeHeroesCatalog(catalogPath, {
      schemaVersion: '1.0', fetchedAt: '2026-08-13T00:00:00Z',
      ...catalogVocabulary,
      services: [{ serviceKey: 'fcl_freight_forwarding' }],
      assetTypes: [{ code: 'container' }, { code: 'truck' }],
      assetSubtypes: [
        { assetType: 'container', subtype: '40HC' },
        { assetType: 'container', subtype: '40DC' },
      ],
    });
    const indexPath = join(workspace, 'rate-catalog.json');
    const conditionalCard = sealedCard({
      id: 'conditional-card',
      journeyType: 'OFFER',
      rules: [{
        id: 'conditional-rule', serviceKey: 'fcl_freight_forwarding',
        locodes: [
          { code: 'NLRTM', role: 'origin' }, { code: 'GBFXT', role: 'transshipment' },
          { code: 'USNYC', role: 'destination' },
        ],
        timeframes: [
          { from: '2026-08-01', to: '2026-12-31' },
          { from: '2026-09-01', to: '2026-09-30' },
        ],
        assetTypes: [
          { type: 'container', subtypes: ['40HC', '40DC'] },
          { type: 'truck', subtypes: [] },
        ],
        participants: [
          { tenantKey: 'carrier-a', role: 'assignee' },
          { tenantKey: 'carrier-b', role: 'assignee' },
        ],
        strategy: { strategyKey: 'OFFER', currentStep: 'PUBLISHED' },
        charges: [{ chargeKey: 'freight', amount: '8000', currency: 'USD', basis: 'container' }],
        conditions: [],
      }],
      sourceEvidence: [{ sourceFile: 'conditional.csv', sourceRef: 'conditional', sourceHash: '2'.repeat(64) }],
      approval: { status: 'approved', approvedBy: 'operator', approvedAt: '2026-08-13T00:00:00Z' },
      catalogReference: { responseHash, fetchedAt: '2026-08-13T00:00:00Z' },
    } as RateCard);
    writeFileSync(indexPath, JSON.stringify({ schemaVersion: '1.0', rateCards: [conditionalCard] }));

    const result = await runTool(workspace, [
      'find-rate.ts', '--service-key', 'fcl_freight_forwarding', '--origin', 'NLRTM', '--dest', 'USNYC',
      '--index', indexPath, '--catalog', catalogPath, '--json',
    ]);
    assert.equal(result.code, 3, result.stderr || result.stdout);
    const discovery = JSON.parse(result.stdout);
    assert.equal(discovery.status, 'incomplete');
    assert.match(discovery.reason, /location GBFXT:transshipment/);
    assert.match(discovery.reason, /timeframe/);
    assert.match(discovery.reason, /asset type/);
    assert.match(discovery.reason, /participant carrier-a or carrier-b:assignee/);
    assert.match(discovery.reason, /strategy OFFER/);

    const complete = await runTool(workspace, [
      'find-rate.ts', '--service-key', 'fcl_freight_forwarding',
      '--origin', 'NLRTM', '--location', 'GBFXT:transshipment', '--dest', 'USNYC',
      '--timeframe', '2026-09-01:2026-09-15', '--asset-type', 'container', '--asset-subtype', '40HC',
      '--asset', 'truck',
      '--participant', 'other:assignee', '--participant', 'carrier-a:assignee',
      '--strategy', 'OFFER', '--strategy-step', 'PUBLISHED',
      '--index', indexPath, '--catalog', catalogPath, '--json',
    ]);
    assert.equal(complete.code, 0, complete.stderr || complete.stdout);
    assert.equal(JSON.parse(complete.stdout).status, 'matched');

    const outsideDeparture = await runTool(workspace, [
      'find-rate.ts', '--service-key', 'fcl_freight_forwarding',
      '--origin', 'NLRTM', '--location', 'GBFXT:transshipment', '--dest', 'USNYC',
      '--timeframe', '2027-01-01:2027-01-15',
      '--asset-type', 'container', '--asset-subtype', '40HC', '--asset', 'truck',
      '--participant', 'other:assignee', '--participant', 'carrier-a:assignee',
      '--strategy', 'OFFER', '--strategy-step', 'PUBLISHED',
      '--index', indexPath, '--catalog', catalogPath, '--json',
    ]);
    assert.equal(outsideDeparture.code, 3, outsideDeparture.stderr || outsideDeparture.stdout);

    const wrongParticipant = await runTool(workspace, [
      'find-rate.ts', '--service-key', 'fcl_freight_forwarding',
      '--origin', 'NLRTM', '--location', 'GBFXT:transshipment', '--dest', 'USNYC',
      '--timeframe', '2026-09-01:2026-09-15', '--asset-type', 'container', '--asset-subtype', '40HC',
      '--asset', 'truck', '--participant', 'other:assignee',
      '--strategy', 'OFFER', '--strategy-step', 'PUBLISHED',
      '--index', indexPath, '--catalog', catalogPath, '--json',
    ]);
    assert.equal(wrongParticipant.code, 3, wrongParticipant.stderr || wrongParticipant.stdout);
    assert.equal(JSON.parse(wrongParticipant.stdout).status, 'none');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('operator exports every charge from the nested contract through the stable CSV adapter', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-export-'));
  try {
    const heroesCatalog = join(workspace, 'heroes-catalog.json');
    const exportCatalogHash = writeHeroesCatalog(heroesCatalog, {
      schemaVersion: '1.0', fetchedAt: '2026-08-13T00:00:00Z',
      ...catalogVocabulary,
      services: [{ serviceKey: 'fcl_freight_forwarding' }], assetTypes: [{ code: 'container' }],
      assetSubtypes: [{ assetType: 'container', subtype: '40HC' }],
    });
    const indexPath = join(workspace, 'rate-catalog.json');
    const exportCard = sealedCard({
        id: 'fcl-card',
        journeyType: 'OFFER',
        rules: [{
          id: 'fcl-rule', serviceKey: 'fcl_freight_forwarding',
          locodes: [
            { code: 'NLRTM', role: 'origin' },
            { code: 'GBFXT', role: 'transshipment' },
            { code: 'USNYC', role: 'destination' },
          ],
          timeframes: [
            { from: '2026-08-01', to: '2026-12-31' },
            { from: '2026-09-01', to: '2026-09-30' },
          ],
          assetTypes: [{ type: 'container', subtypes: ['40HC'] }],
          participants: [{ tenantKey: 'carrier-a', role: 'assignee' }],
          strategy: { strategyKey: 'OFFER', currentStep: 'PUBLISHED' },
          charges: [
            {
              chargeKey: 'ocean-freight', currency: 'USD', basis: 'cbm',
              minimum: '500', maximum: '9000',
              tiers: [{ upTo: '10', amount: '90' }, { upTo: null, amount: '80' }],
            },
            { chargeKey: 'documentation', amount: '45', currency: 'USD', basis: 'document' },
          ],
          conditions: ['subject to space', 'dangerous goods excluded'],
        }],
        sourceEvidence: [{ sourceFile: 'filed.csv', sourceRef: 'FCL-9', sourceHash: 'f'.repeat(64) }],
        approval: { status: 'approved', approvedBy: 'operator', approvedAt: '2026-08-13T00:00:00Z' },
        catalogReference: { responseHash: exportCatalogHash, fetchedAt: '2026-08-13T00:00:00Z' },
      } as RateCard);
    writeFileSync(indexPath, JSON.stringify({ schemaVersion: '1.0', rateCards: [exportCard] }));
    const output = join(workspace, 'rates.csv');
    const result = await runTool(workspace, ['export-rates.ts', '--index', indexPath, '--output', output]);

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const rows = readFileSync(output, 'utf8').trim().split('\n');
    assert.equal(rows.length, 3);
    assert.match(rows[0], /^cardId,ruleId,serviceKey,origin,destination,/);
    assert.match(rows[1], /ocean-freight,,USD,cbm,500,9000/);
    assert.match(rows[2], /documentation,45,USD,document/);
    assert.equal(rows.every((row) => row.includes('workspace-key')), false);

    const sealedIndex = readFileSync(indexPath, 'utf8');
    const editedIndex = JSON.parse(sealedIndex);
    editedIndex.rateCards[0].rules[0].charges[1].amount = '46';
    writeFileSync(indexPath, JSON.stringify(editedIndex));
    const unsafeExport = await runTool(workspace, [
      'export-rates.ts', '--index', indexPath, '--output', join(workspace, 'unsafe.csv'),
    ]);
    assert.equal(unsafeExport.code, 1, unsafeExport.stdout + unsafeExport.stderr);
    assert.match(unsafeExport.stderr, /approved content hash does not match/);
    writeFileSync(indexPath, sealedIndex);

    const inbox = join(workspace, 'inbox');
    mkdirSync(inbox);
    writeFileSync(join(inbox, 'exported.csv'), readFileSync(output));
    const importedIndex = join(workspace, 'imported.json');
    const importResult = await runTool(workspace, [
      'ingest-rates.ts', inbox, '--catalog', heroesCatalog, '--index', importedIndex,
      '--processed', join(workspace, 'processed'),
    ]);
    assert.equal(importResult.code, 0, importResult.stderr || importResult.stdout);
    const importedRule = JSON.parse(readFileSync(importedIndex, 'utf8')).rateCards[0].rules[0];
    assert.deepEqual(importedRule.locodes, [
      { code: 'NLRTM', role: 'origin' },
      { code: 'GBFXT', role: 'transshipment' },
      { code: 'USNYC', role: 'destination' },
    ]);
    assert.deepEqual(importedRule.participants, [{ tenantKey: 'carrier-a', role: 'assignee' }]);
    assert.deepEqual(importedRule.strategy, { strategyKey: 'OFFER', currentStep: 'PUBLISHED' });
    assert.deepEqual(importedRule.conditions, ['subject to space', 'dangerous goods excluded']);
    assert.deepEqual(JSON.parse(readFileSync(importedIndex, 'utf8')).rateCards[0].sourceEvidence, [
      { sourceFile: 'filed.csv', sourceRef: 'FCL-9', sourceHash: 'f'.repeat(64) },
    ]);
    assert.deepEqual(importedRule.timeframes, [
      { from: '2026-08-01', to: '2026-12-31' },
      { from: '2026-09-01', to: '2026-09-30' },
    ]);
    assert.deepEqual(importedRule.charges[0], {
      chargeKey: 'ocean-freight', currency: 'USD', basis: 'cbm',
      minimum: '500', maximum: '9000',
      tiers: [{ upTo: '10', amount: '90' }, { upTo: null, amount: '80' }],
    });

    const tamperedInbox = join(workspace, 'tampered-inbox');
    mkdirSync(tamperedInbox);
    const tamperedCsv = readFileSync(output, 'utf8').replace(
      'ocean-freight,,USD,cbm,500,9000',
      'ocean-freight,,USD,cbm,501,9000',
    );
    writeFileSync(join(tamperedInbox, 'tampered.csv'), tamperedCsv);
    const tamperedImport = await runTool(workspace, [
      'ingest-rates.ts', tamperedInbox, '--catalog', heroesCatalog,
      '--index', join(workspace, 'tampered-index.json'), '--processed', join(workspace, 'tampered-processed'),
    ]);
    assert.equal(tamperedImport.code, 1, tamperedImport.stdout + tamperedImport.stderr);
    assert.match(tamperedImport.stderr, /content changed after approval/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
