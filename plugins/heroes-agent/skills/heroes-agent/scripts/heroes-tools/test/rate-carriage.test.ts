import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Carriage } from '../carriage';
import {
  approveRateCard,
  computeHeroesCatalogHash,
  discoverRate,
  exportRateCsv,
  importRateCsv,
  type HeroesRateCatalog,
  type RateCard,
  type RateCatalog,
} from '../rate-contract';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(toolsDir, '..', '..', '..', '..');
const launcher = join(pluginRoot, 'scripts', 'run-tool.mjs');

const fcl: Carriage = {
  containerAllocation: 'exclusive',
  vehicleType: 'vessel',
  vehicleAllocation: 'shared',
  handlingMethod: 'lift_on_lift_off',
};

const lcl: Carriage = {
  containerAllocation: 'shared',
  vehicleType: 'vessel',
  vehicleAllocation: 'shared',
  handlingMethod: 'lift_on_lift_off',
};

function heroesCatalog(schemaVersion: '1.0' | '1.1' = '1.1'): HeroesRateCatalog {
  const catalog: HeroesRateCatalog = {
    schemaVersion,
    fetchedAt: '2026-10-21T00:00:00Z',
    responseHash: '',
    openApiVersion: '0.1.test',
    services: [{ serviceKey: 'oceanfreight' }],
    assetTypes: [{ code: 'container' }],
    assetSubtypes: [{ assetType: 'container', subtype: '40HC' }],
    locationRoles: ['origin', 'destination'],
    timeframeKinds: ['validity'],
    participantRoles: ['issuer', 'recipient'],
    strategies: [],
  };
  catalog.responseHash = computeHeroesCatalogHash(catalog);
  return catalog;
}

function card(id: string, catalog: HeroesRateCatalog, carriage?: Carriage): RateCard {
  const value: RateCard = {
    id,
    journeyType: 'OFFER',
    rules: [{
      id: `${id}-rule`,
      serviceKey: 'oceanfreight',
      locodes: [
        { code: 'NLRTM', role: 'origin' },
        { code: 'USNYC', role: 'destination' },
      ],
      timeframes: [{ from: '2026-10-01', to: '2026-10-31' }],
      assetTypes: [{ type: 'container', subtypes: ['40HC'] }],
      participants: [],
      strategy: null,
      ...(carriage ? { carriage } : {}),
      charges: [{ chargeKey: 'freight', amount: '900', currency: 'USD', basis: 'container' }],
      conditions: [],
    }],
    sourceEvidence: [{ sourceFile: `${id}.csv`, sourceRef: id, sourceHash: 'a'.repeat(64) }],
    approval: { status: 'approved', approvedBy: 'operator', approvedAt: '2026-10-21T00:00:00Z' },
    catalogReference: { responseHash: catalog.responseHash, fetchedAt: catalog.fetchedAt },
  };
  approveRateCard(value, 'operator', '2026-10-21T00:00:00Z');
  return value;
}

const baseQuery = {
  serviceKey: 'oceanfreight',
  locodes: [
    { code: 'NLRTM', role: 'origin' },
    { code: 'USNYC', role: 'destination' },
  ],
  timeframes: [{ from: '2026-10-21', to: '2026-10-21' }],
  assetTypes: [{ type: 'container', subtypes: ['40HC'] }],
};

function runTool(
  workspace: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveProcess) => {
    const child = spawn(process.execPath, [launcher, ...args], { cwd: workspace });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolveProcess({ code, stdout, stderr }));
  });
}

test('carriage makes otherwise identical FCL and LCL rules deterministic', () => {
  const catalog = heroesCatalog();
  const rates: RateCatalog = {
    schemaVersion: '1.1',
    rateCards: [card('fcl', catalog, fcl), card('lcl', catalog, lcl)],
  };

  const matched = discoverRate(rates, catalog, { ...baseQuery, carriage: fcl });
  assert.equal(matched.status, 'matched');
  assert.equal(matched.rate?.cardId, 'fcl');
  assert.equal(matched.candidateTotal, 1);

  const missing = discoverRate(rates, catalog, baseQuery);
  assert.equal(missing.status, 'incomplete');
  assert.equal(missing.candidateTotal, 2);
  assert.deepEqual(missing.candidates.map((candidate) => candidate.missingFacts), [
    ['carriage'], ['carriage'],
  ]);
});

test('a 1.0 transport card remains readable but cannot hide a qualified rule', () => {
  const catalog = heroesCatalog('1.0');
  const rates: RateCatalog = {
    schemaVersion: '1.0',
    rateCards: [card('legacy', catalog), card('fcl', catalog, fcl)],
  };

  const result = discoverRate(rates, catalog, { ...baseQuery, carriage: fcl });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.candidateTotal, 2);
  assert.deepEqual(
    result.candidates.find((candidate) => candidate.cardId === 'legacy')?.missingFacts,
    ['rate rule carriage'],
  );
  assert.equal(result.candidates.find((candidate) => candidate.cardId === 'fcl')?.class, 'eligible');
});

test('the CSV adapter preserves carriageJson while upgrading imports to 1.1', () => {
  const catalog = heroesCatalog('1.0');
  const carriageJson = JSON.stringify(fcl).replaceAll('"', '""');
  const csv = [
    'cardId,ruleId,serviceKey,origin,destination,assetType,assetSubtype,validFrom,validTo,chargeKey,amount,currency,basis,sourceRef,approvalStatus,approvedBy,approvedAt,carriageJson',
    `fcl,fcl-rule,oceanfreight,NLRTM,USNYC,container,40HC,2026-10-01,2026-10-31,freight,900,USD,container,FCL,draft,,,"${carriageJson}"`,
  ].join('\n');

  const imported = importRateCsv(csv, 'rates.csv', catalog);
  assert.equal(imported.schemaVersion, '1.1');
  assert.deepEqual(imported.rateCards[0].rules[0].carriage, fcl);

  const exported = exportRateCsv(imported);
  assert.match(exported.split('\n')[0], /carriageJson/);
  const roundTripped = importRateCsv(exported, 'exported.csv', catalog);
  assert.deepEqual(roundTripped.rateCards[0].rules[0].carriage, fcl);

  const samplePath = join(
    pluginRoot, 'skills', 'heroes-agent', 'assets', 'peer-template', 'self', 'rate-book', 'sample-rates.csv',
  );
  const sample = importRateCsv(readFileSync(samplePath, 'utf8'), 'sample-rates.csv', catalog);
  assert.equal(sample.rateCards[0].rules[0].serviceKey, 'oceanfreight');
  assert.deepEqual(sample.rateCards[0].rules[0].carriage, fcl);
});

test('find-rate accepts carriage from a JSON file or individual flags', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-carriage-'));
  try {
    const catalog = heroesCatalog();
    const catalogPath = join(workspace, 'heroes-catalog.json');
    const indexPath = join(workspace, 'rate-catalog.json');
    const carriagePath = join(workspace, 'fcl.json');
    writeFileSync(catalogPath, JSON.stringify(catalog));
    writeFileSync(indexPath, JSON.stringify({
      schemaVersion: '1.1',
      rateCards: [card('fcl', catalog, fcl), card('lcl', catalog, lcl)],
    }));
    writeFileSync(carriagePath, JSON.stringify(fcl));
    const common = [
      '--service-key', 'oceanfreight', '--origin', 'NLRTM', '--dest', 'USNYC',
      '--asset-type', 'container', '--asset-subtype', '40HC', '--date', '2026-10-21',
      '--index', indexPath, '--catalog', catalogPath, '--json',
    ];

    const fromFile = await runTool(workspace, ['find-rate.ts', ...common, '--carriage', carriagePath]);
    assert.equal(fromFile.code, 0, fromFile.stderr || fromFile.stdout);
    assert.equal(JSON.parse(fromFile.stdout).rate.cardId, 'fcl');

    const fromFlags = await runTool(workspace, [
      'find-rate.ts', ...common,
      '--container-allocation', 'shared', '--vehicle-type', 'vessel',
      '--vehicle-allocation', 'shared', '--handling-method', 'lift_on_lift_off',
    ]);
    assert.equal(fromFlags.code, 0, fromFlags.stderr || fromFlags.stdout);
    assert.equal(JSON.parse(fromFlags.stdout).rate.cardId, 'lcl');

    const missingFile = await runTool(workspace, ['find-rate.ts', ...common, '--carriage']);
    assert.equal(missingFile.code, 4, missingFile.stderr || missingFile.stdout);
    assert.match(JSON.parse(missingFile.stdout).reason, /requires a JSON file/);

    assert.equal(readFileSync(carriagePath, 'utf8'), JSON.stringify(fcl));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
