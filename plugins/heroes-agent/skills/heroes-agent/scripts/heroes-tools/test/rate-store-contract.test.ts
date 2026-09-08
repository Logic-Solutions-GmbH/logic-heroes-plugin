import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { computeHeroesCatalogHash, type HeroesRateCatalog } from '../rate-contract';
import {
  createInMemoryRateStore, openRateStore, type RateStore,
} from '../rate-store';

function heroesCatalog(): HeroesRateCatalog {
  const catalog: HeroesRateCatalog = {
    schemaVersion: '1.0',
    fetchedAt: '2026-09-08T00:00:00Z',
    responseHash: '',
    openApiVersion: '0.1.test',
    services: [{ serviceKey: 'fcl_freight_forwarding' }],
    assetTypes: [{ code: 'container' }],
    assetSubtypes: [{ assetType: 'container', subtype: '40HC' }],
    locationRoles: ['origin', 'destination'],
    timeframeKinds: ['validity'],
    participantRoles: ['issuer', 'recipient'],
    strategies: [{ strategyKey: 'OFFER', steps: ['PUBLISHED'] }],
  };
  catalog.responseHash = computeHeroesCatalogHash(catalog);
  return catalog;
}

function csv(cardId: string, ruleId: string, amount: string): string {
  return [
    'cardId,ruleId,serviceKey,origin,destination,assetType,assetSubtype,validFrom,validTo,chargeKey,amount,currency,basis,sourceRef,approvalStatus,approvedBy,approvedAt',
    `${cardId},${ruleId},fcl_freight_forwarding,nlrtm,usnyc,container,40HC,2026-09-01,2026-09-30,freight,${amount},usd,container,${cardId}-source,draft,,,`,
  ].join('\n');
}

const query = {
  serviceKey: 'fcl_freight_forwarding',
  locodes: [
    { code: 'NLRTM', role: 'origin' },
    { code: 'USNYC', role: 'destination' },
  ],
  timeframes: [{ from: '2026-09-08', to: '2026-09-08' }],
  assetTypes: [{ type: 'container', subtypes: ['40HC'] }],
};

interface Harness {
  store: RateStore;
  cleanup(): void;
}

const adapters: { name: string; create(): Harness }[] = [
  {
    name: 'CSV',
    create() {
      const workspace = mkdtempSync(join(tmpdir(), 'heroes-csv-rate-store-'));
      const catalogPath = join(workspace, 'heroes-catalog.json');
      writeFileSync(catalogPath, JSON.stringify(heroesCatalog()));
      return {
        store: openRateStore({
          indexPath: join(workspace, 'rate-catalog.json'),
          catalogPath,
        }),
        cleanup: () => rmSync(workspace, { recursive: true, force: true }),
      };
    },
  },
  {
    name: 'in-memory',
    create() {
      return { store: createInMemoryRateStore({ heroesCatalog: heroesCatalog() }), cleanup() {} };
    },
  },
];

for (const adapter of adapters) {
  describe(`${adapter.name} rate-store contract`, () => {
    test('ingestRates normalizes aliases and preserves approval plus source provenance', async () => {
      const harness = adapter.create();
      try {
        await harness.store.ingestRates({
          sources: [{ sourceFile: 'rates.csv', csv: csv('card-1', 'rule-1', '900') }],
          approveBy: 'operator',
        });

        const result = await harness.store.findRate(query);

        assert.equal(result.status, 'matched');
        assert.equal(result.rate?.cardId, 'card-1');
        assert.deepEqual(result.rate?.rule.locodes, [
          { code: 'NLRTM', role: 'origin' },
          { code: 'USNYC', role: 'destination' },
        ]);
        assert.equal(result.rate?.rule.charges[0].currency, 'USD');
        assert.deepEqual(
          result.rate?.sourceEvidence.map(({ sourceFile, sourceRef }) => ({ sourceFile, sourceRef })),
          [{ sourceFile: 'rates.csv', sourceRef: 'card-1-source' }],
        );
      } finally {
        harness.cleanup();
      }
    });

    test('findRate escalates when two complete approved current rates apply', async () => {
      const harness = adapter.create();
      try {
        await harness.store.ingestRates({
          sources: [
            { sourceFile: 'first.csv', csv: csv('card-1', 'rule-1', '900') },
            { sourceFile: 'second.csv', csv: csv('card-2', 'rule-2', '800') },
          ],
          approveBy: 'operator',
        });

        const result = await harness.store.findRate(query);

        assert.equal(result.status, 'ambiguous');
        assert.equal(result.match, false);
        assert.equal(result.rate, undefined);
        assert.equal(result.candidateTotal, 2);
      } finally {
        harness.cleanup();
      }
    });

    test('ingestRates rejects malformed input before it changes the store', async () => {
      const harness = adapter.create();
      try {
        const malformed = csv('card-1', 'rule-1', '900').replace(',usd,', ',not-a-currency,');
        await assert.rejects(
          harness.store.ingestRates({
            sources: [{ sourceFile: 'bad.csv', csv: malformed }],
            approveBy: 'operator',
          }),
          /currency must be an ISO 4217 code/,
        );

        await harness.store.ingestRates({
          sources: [{ sourceFile: 'good.csv', csv: csv('card-1', 'rule-1', '900') }],
          approveBy: 'operator',
        });
        assert.equal((await harness.store.findRate(query)).status, 'matched');
      } finally {
        harness.cleanup();
      }
    });

    test('an empty ingestion creates the same usable empty store', async () => {
      const harness = adapter.create();
      try {
        assert.deepEqual(await harness.store.ingestRates({ sources: [] }), {
          files: 0,
          cards: 0,
          catalogHash: heroesCatalog().responseHash,
          staleCards: 0,
          committed: true,
        });
        assert.equal((await harness.store.findRate(query)).status, 'none');
      } finally {
        harness.cleanup();
      }
    });
  });
}
