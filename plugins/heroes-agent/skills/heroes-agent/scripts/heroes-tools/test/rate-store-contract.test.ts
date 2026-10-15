import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  stageSources(sources: { sourceFile: string; csv: string }[]): void;
  cleanup(): void;
}

async function ingest(
  harness: Harness,
  request: Parameters<RateStore['ingestRates']>[0],
): ReturnType<RateStore['ingestRates']> {
  harness.stageSources(request.sources);
  return harness.store.ingestRates(request);
}

const adapters: { name: string; create(): Harness }[] = [
  {
    name: 'CSV',
    create() {
      const workspace = mkdtempSync(join(tmpdir(), 'heroes-csv-rate-store-'));
      const catalogPath = join(workspace, 'heroes-catalog.json');
      const inbox = join(workspace, 'inbox');
      const processedDir = join(workspace, 'processed');
      mkdirSync(inbox);
      writeFileSync(catalogPath, JSON.stringify(heroesCatalog()));
      return {
        store: openRateStore({
          indexPath: join(workspace, 'rate-catalog.json'),
          catalogPath,
          archive: { inbox, processedDir },
        }),
        stageSources(sources) {
          for (const source of sources) writeFileSync(join(inbox, source.sourceFile), source.csv);
        },
        cleanup: () => rmSync(workspace, { recursive: true, force: true }),
      };
    },
  },
  {
    name: 'in-memory',
    create() {
      return {
        store: createInMemoryRateStore({ heroesCatalog: heroesCatalog() }),
        stageSources() {},
        cleanup() {},
      };
    },
  },
];

for (const adapter of adapters) {
  describe(`${adapter.name} rate-store contract`, () => {
    test('ingestRates normalizes aliases and preserves approval plus source provenance', async () => {
      const harness = adapter.create();
      try {
        await ingest(harness, {
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

    test('listRateCards returns the stored catalog without exposing mutable state', async () => {
      const harness = adapter.create();
      try {
        await ingest(harness, {
          sources: [{ sourceFile: 'rates.csv', csv: csv('card-1', 'rule-1', '900') }],
          approveBy: 'operator',
        });

        const catalog = await harness.store.listRateCards();
        assert.equal(catalog.rateCards.length, 1);
        assert.equal(catalog.rateCards[0].id, 'card-1');
        catalog.rateCards.length = 0;
        assert.equal((await harness.store.listRateCards()).rateCards.length, 1);
      } finally {
        harness.cleanup();
      }
    });

    test('findRate escalates when two complete approved current rates apply', async () => {
      const harness = adapter.create();
      try {
        await ingest(harness, {
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
          ingest(harness, {
            sources: [{ sourceFile: 'bad.csv', csv: malformed }],
            approveBy: 'operator',
          }),
          /currency must be an ISO 4217 code/,
        );

        await ingest(harness, {
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
        assert.deepEqual(await ingest(harness, { sources: [] }), {
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

    test('findRate rejects one complete current rate that lacks approval', async () => {
      const harness = adapter.create();
      try {
        await ingest(harness, {
          sources: [{ sourceFile: 'draft.csv', csv: csv('card-1', 'rule-1', '900') }],
        });

        const result = await harness.store.findRate(query);

        assert.equal(result.status, 'none');
        assert.equal(result.match, false);
        assert.equal(result.candidateTotal, 1);
      } finally {
        harness.cleanup();
      }
    });
  });
}
