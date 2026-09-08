import {
  existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { flagString } from './lib';
import {
  approveRateCard, discoverRate, importRateCsv, validateRateCatalog,
  type HeroesRateCatalog, type RateCatalog, type RateDiscovery, type RateDiscoveryQuery,
} from './rate-contract';

export interface RateIngestSource {
  sourceFile: string;
  csv: string;
}

export interface RateIngestRequest {
  sources: RateIngestSource[];
  approveBy?: string;
  dryRun?: boolean;
}

export interface RateIngestResult {
  files: number;
  cards: number;
  catalogHash: string;
  staleCards: number;
  committed: boolean;
}

export interface RateStore {
  ingestRates(request: RateIngestRequest): Promise<RateIngestResult>;
  findRate(query: RateDiscoveryQuery): Promise<RateDiscovery>;
}

export class RateStoreUnavailableError extends Error {}

interface PreparedIngestion {
  catalog: RateCatalog;
  result: Omit<RateIngestResult, 'committed'>;
}

function prepareIngestion(
  existingCatalog: RateCatalog,
  heroesCatalog: HeroesRateCatalog,
  request: RateIngestRequest,
  approvedAt: string,
): PreparedIngestion {
  if (existingCatalog.schemaVersion !== '1.0') {
    throw new Error(`Unsupported rate catalog version: ${existingCatalog.schemaVersion}`);
  }
  const imported = request.sources.map(({ sourceFile, csv }) =>
    importRateCsv(csv, sourceFile, heroesCatalog),
  );
  if (request.approveBy) {
    for (const batch of imported) for (const card of batch.rateCards) {
      if (card.approval.status !== 'draft') throw new Error(`Card ${card.id} is already approved`);
      approveRateCard(card, request.approveBy, approvedAt);
    }
  }

  const catalog = structuredClone(existingCatalog);
  const ids = new Set(catalog.rateCards.map((card) => card.id));
  for (const batch of imported) for (const card of batch.rateCards) {
    if (ids.has(card.id)) throw new Error(`Duplicate rate card id: ${card.id}`);
    ids.add(card.id);
    catalog.rateCards.push(card);
  }
  catalog.rateCards.sort((left, right) => left.id.localeCompare(right.id));
  const issues = validateRateCatalog(catalog, heroesCatalog);
  if (issues.length) throw new Error(issues.join('; '));

  return {
    catalog,
    result: {
      files: request.sources.length,
      cards: imported.reduce((sum, batch) => sum + batch.rateCards.length, 0),
      catalogHash: heroesCatalog.responseHash,
      staleCards: catalog.rateCards.filter((card) =>
        card.catalogReference.responseHash !== heroesCatalog.responseHash,
      ).length,
    },
  };
}

function invalidDiscovery(query: RateDiscoveryQuery, error: unknown): RateDiscovery {
  return {
    status: 'invalid',
    match: false,
    reason: error instanceof Error ? error.message : 'invalid rate catalog',
    query,
    candidates: [],
    candidateTotal: 0,
    candidatesTruncated: false,
  };
}

export function createInMemoryRateStore(options: {
  heroesCatalog: HeroesRateCatalog;
  initialCatalog?: RateCatalog;
  now?: () => string;
}): RateStore {
  let rateCatalog: RateCatalog = structuredClone(
    options.initialCatalog ?? { schemaVersion: '1.0', rateCards: [] },
  );
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async ingestRates(request) {
      const prepared = prepareIngestion(rateCatalog, options.heroesCatalog, request, now());
      if (!request.dryRun) rateCatalog = prepared.catalog;
      return { ...prepared.result, committed: !request.dryRun };
    },
    async findRate(query) {
      try {
        return discoverRate(rateCatalog, options.heroesCatalog, query);
      } catch (error) {
        return invalidDiscovery(query, error);
      }
    },
  };
}

interface RateStoreOptions {
  indexPath: string;
  catalogPath: string;
  archive?: { inbox: string; processedDir: string };
  transactionMode?: 'recover' | 'refuse';
  requireCatalogOnOpen?: boolean;
  now?: () => string;
}

function recoveryFileState(transaction: {
  inbox: string;
  processedDir: string;
}, file: string): { source: string; archived: string; sourceExists: boolean; archiveExists: boolean } {
  const source = join(transaction.inbox, file);
  const archived = join(transaction.processedDir, file);
  const sourceExists = existsSync(source);
  const archiveExists = existsSync(archived);
  if (sourceExists && archiveExists) {
    throw new Error(`Cannot recover ${file}: expected exactly one source or archived copy`);
  }
  return { source, archived, sourceExists, archiveExists };
}

function recoverCsvTransaction(indexPath: string): void {
  const transactionPath = `${indexPath}.transaction.json`;
  const nextIndex = `${indexPath}.next`;
  if (existsSync(nextIndex) && !existsSync(transactionPath)) unlinkSync(nextIndex);
  if (!existsSync(transactionPath)) return;

  const transaction = JSON.parse(readFileSync(transactionPath, 'utf8')) as {
    inbox: string;
    processedDir: string;
    files: string[];
    phase?: 'preparing' | 'staged' | 'committed';
  };
  if (transaction.phase === 'preparing') {
    if (existsSync(nextIndex)) unlinkSync(nextIndex);
    unlinkSync(transactionPath);
    return;
  }
  if (existsSync(nextIndex)) {
    for (const file of transaction.files) {
      const { source, archived, archiveExists } = recoveryFileState(transaction, file);
      if (archiveExists) renameSync(archived, source);
    }
    unlinkSync(nextIndex);
  } else {
    for (const file of transaction.files) {
      const { source, archived, sourceExists } = recoveryFileState(transaction, file);
      if (sourceExists) renameSync(source, archived);
    }
  }
  if (existsSync(transactionPath)) unlinkSync(transactionPath);
}

function prepareRateStoreTransaction(
  indexPath: string,
  mode: RateStoreOptions['transactionMode'],
): void {
  const transactionPath = `${indexPath}.transaction.json`;
  const nextIndex = `${indexPath}.next`;
  if (mode === 'refuse' && (existsSync(transactionPath) || existsSync(nextIndex))) {
    throw new Error('A pending import transaction requires a normal ingest run for recovery');
  }
  if (mode === 'recover') recoverCsvTransaction(indexPath);
}

/** Open the configured durable rate store. The current adapter is local and CSV-compatible. */
export function openRateStore(options: RateStoreOptions): RateStore {
  const transactionPath = `${options.indexPath}.transaction.json`;
  prepareRateStoreTransaction(options.indexPath, options.transactionMode);
  if (options.requireCatalogOnOpen && !existsSync(options.catalogPath)) {
    throw new RateStoreUnavailableError(
      `Heroes catalog not found: ${options.catalogPath}. Run sync-rate-catalog.ts first.`,
    );
  }
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async ingestRates(request) {
      if (!existsSync(options.catalogPath)) {
        throw new RateStoreUnavailableError(
          `Heroes catalog not found: ${options.catalogPath}. Run sync-rate-catalog.ts first.`,
        );
      }
      const heroesCatalog = JSON.parse(readFileSync(options.catalogPath, 'utf8')) as HeroesRateCatalog;
      const existingCatalog: RateCatalog = existsSync(options.indexPath)
        ? JSON.parse(readFileSync(options.indexPath, 'utf8'))
        : { schemaVersion: '1.0', rateCards: [] };
      const prepared = prepareIngestion(existingCatalog, heroesCatalog, request, now());
      if (request.dryRun) return { ...prepared.result, committed: false };

      mkdirSync(dirname(options.indexPath), { recursive: true });
      const nextIndex = `${options.indexPath}.next`;
      if (!options.archive) {
        writeFileSync(nextIndex, `${JSON.stringify(prepared.catalog, null, 2)}\n`, { mode: 0o600 });
        renameSync(nextIndex, options.indexPath);
        return { ...prepared.result, committed: true };
      }

      const { inbox, processedDir } = options.archive;
      const files = request.sources.map(({ sourceFile }) => sourceFile);
      mkdirSync(processedDir, { recursive: true });
      for (const file of files) {
        const destination = join(processedDir, file);
        if (existsSync(destination)) throw new Error(`Processed file already exists: ${destination}`);
      }
      const transaction = (phase: 'preparing' | 'staged' | 'committed') =>
        `${JSON.stringify({ inbox, processedDir, files, phase }, null, 2)}\n`;
      writeFileSync(transactionPath, transaction('preparing'), { mode: 0o600 });
      writeFileSync(nextIndex, `${JSON.stringify(prepared.catalog, null, 2)}\n`, { mode: 0o600 });
      writeFileSync(transactionPath, transaction('staged'), { mode: 0o600 });
      const archived: string[] = [];
      try {
        renameSync(nextIndex, options.indexPath);
        writeFileSync(transactionPath, transaction('committed'), { mode: 0o600 });
        for (const file of files) {
          renameSync(join(inbox, file), join(processedDir, file));
          archived.push(file);
        }
        unlinkSync(transactionPath);
      } catch (error) {
        if (existsSync(nextIndex)) {
          for (const file of archived.reverse()) renameSync(join(processedDir, file), join(inbox, file));
          unlinkSync(nextIndex);
          if (existsSync(transactionPath)) unlinkSync(transactionPath);
        }
        throw error;
      }
      return { ...prepared.result, committed: true };
    },
    async findRate(query) {
      if (!existsSync(options.indexPath) || !existsSync(options.catalogPath)) {
        throw new RateStoreUnavailableError(
          `rate index and Heroes catalog are required (${options.indexPath}; ${options.catalogPath})`,
        );
      }
      try {
        const rateCatalog = JSON.parse(readFileSync(options.indexPath, 'utf8')) as RateCatalog;
        const heroesCatalog = JSON.parse(readFileSync(options.catalogPath, 'utf8')) as HeroesRateCatalog;
        return discoverRate(rateCatalog, heroesCatalog, query);
      } catch (error) {
        return invalidDiscovery(query, error);
      }
    },
  };
}

export function openConfiguredRateStore(
  flags: Record<string, string | boolean>,
): { store: RateStore; writeLocation: string } {
  const indexPath = flagString(flags, 'index') ?? 'self/rate-book/index/rate-catalog.json';
  const catalogPath = flagString(flags, 'catalog') ?? 'self/rate-book/index/heroes-catalog.json';
  return {
    store: openRateStore({ indexPath, catalogPath }),
    writeLocation: indexPath,
  };
}

export function prepareConfiguredRateIngestion(
  flags: Record<string, string | boolean>,
  dryRun: boolean,
): (source: { inbox: string; processedDir: string }) => { store: RateStore; writeLocation: string } {
  const indexPath = flagString(flags, 'index') ?? 'self/rate-book/index/rate-catalog.json';
  const catalogPath = flagString(flags, 'catalog') ?? 'self/rate-book/index/heroes-catalog.json';
  prepareRateStoreTransaction(indexPath, dryRun ? 'refuse' : 'recover');
  return ({ inbox, processedDir }) => ({
    store: openRateStore({
      indexPath,
      catalogPath,
      archive: { inbox, processedDir },
      requireCatalogOnOpen: true,
    }),
    writeLocation: indexPath,
  });
}
