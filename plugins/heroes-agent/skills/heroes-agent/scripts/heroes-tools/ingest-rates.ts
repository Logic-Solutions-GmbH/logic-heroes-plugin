/** Import stable CSV adapter rows into the versioned Heroes-shaped rate catalog. */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { flagString, heading, kv, parseArgs, run } from './lib';
import {
  approveRateCard, importRateCsv, validateRateCatalog, type HeroesRateCatalog, type RateCatalog,
} from './rate-contract';

run(async () => {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const inbox = positional[0] ?? flagString(flags, 'inbox') ?? 'self/rate-book/inbox';
  const indexPath = flagString(flags, 'index') ?? 'self/rate-book/index/rate-catalog.json';
  const catalogPath = flagString(flags, 'catalog') ?? 'self/rate-book/index/heroes-catalog.json';
  const processedDir = flagString(flags, 'processed') ?? 'self/rate-book/processed';
  const approveBy = flagString(flags, 'approve-by');
  const dryRun = flags['dry-run'] === true;
  const transactionPath = `${indexPath}.transaction.json`;
  const nextIndex = `${indexPath}.next`;

  if (dryRun && (existsSync(transactionPath) || existsSync(nextIndex))) {
    throw new Error('A pending import transaction requires a normal ingest run for recovery');
  }
  if (existsSync(nextIndex) && !existsSync(transactionPath)) unlinkSync(nextIndex);
  if (existsSync(transactionPath)) {
    const transaction = JSON.parse(readFileSync(transactionPath, 'utf8')) as {
      inbox: string; processedDir: string; files: string[]; phase?: 'preparing' | 'staged' | 'committed';
    };
    if (transaction.phase === 'preparing') {
      if (existsSync(nextIndex)) unlinkSync(nextIndex);
      unlinkSync(transactionPath);
    } else if (existsSync(nextIndex)) {
      for (const file of transaction.files) {
        const archived = join(transaction.processedDir, file);
        const source = join(transaction.inbox, file);
        const sourceExists = existsSync(source);
        const archiveExists = existsSync(archived);
        if (sourceExists === archiveExists) {
          throw new Error(`Cannot recover ${file}: expected exactly one source or archived copy`);
        }
        if (archiveExists) renameSync(archived, source);
      }
      unlinkSync(nextIndex);
    } else {
      for (const file of transaction.files) {
        const source = join(transaction.inbox, file);
        const archived = join(transaction.processedDir, file);
        const sourceExists = existsSync(source);
        const archiveExists = existsSync(archived);
        if (sourceExists === archiveExists) {
          throw new Error(`Cannot recover ${file}: expected exactly one source or archived copy`);
        }
        if (sourceExists) renameSync(source, archived);
      }
    }
    if (existsSync(transactionPath)) unlinkSync(transactionPath);
  }

  if (!existsSync(inbox)) throw new Error(`Inbox not found: ${inbox}`);
  if (!existsSync(catalogPath)) {
    throw new Error(`Heroes catalog not found: ${catalogPath}. Run sync-rate-catalog.ts first.`);
  }
  const heroesCatalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as HeroesRateCatalog;
  const files = readdirSync(inbox).filter((file) =>
    !file.startsWith('.') && statSync(join(inbox, file)).isFile() && extname(file).toLowerCase() === '.csv',
  );
  if (files.length === 0) {
    heading('Nothing to ingest');
    kv('inbox', inbox);
    return;
  }

  const imported: RateCatalog[] = files.map((file) =>
    importRateCsv(readFileSync(join(inbox, file), 'utf8'), basename(file), heroesCatalog),
  );
  if (approveBy) {
    const approvedAt = new Date().toISOString();
    for (const batch of imported) for (const card of batch.rateCards) {
      if (card.approval.status !== 'draft') throw new Error(`Card ${card.id} is already approved`);
      approveRateCard(card, approveBy, approvedAt);
    }
  }
  const existing: RateCatalog = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, 'utf8'))
    : { schemaVersion: '1.0', rateCards: [] };
  if (existing.schemaVersion !== '1.0') throw new Error(`Unsupported rate catalog version: ${existing.schemaVersion}`);
  const ids = new Set(existing.rateCards.map((card) => card.id));
  for (const batch of imported) {
    for (const card of batch.rateCards) {
      if (ids.has(card.id)) throw new Error(`Duplicate rate card id: ${card.id}`);
      ids.add(card.id);
      existing.rateCards.push(card);
    }
  }
  existing.rateCards.sort((a, b) => a.id.localeCompare(b.id));
  const issues = validateRateCatalog(existing, heroesCatalog);
  if (issues.length) throw new Error(issues.join('; '));

  heading('Rate import');
  kv('files', files.length);
  kv('cards', imported.reduce((sum, batch) => sum + batch.rateCards.length, 0));
  kv('catalog hash', heroesCatalog.responseHash);
  if (dryRun) {
    kv('status', 'valid; no files changed');
    return;
  }

  mkdirSync(dirname(indexPath), { recursive: true });
  mkdirSync(processedDir, { recursive: true });
  for (const file of files) {
    const destination = join(processedDir, file);
    if (existsSync(destination)) throw new Error(`Processed file already exists: ${destination}`);
  }
  writeFileSync(transactionPath, `${JSON.stringify({ inbox, processedDir, files, phase: 'preparing' }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(nextIndex, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(transactionPath, `${JSON.stringify({ inbox, processedDir, files, phase: 'staged' }, null, 2)}\n`, { mode: 0o600 });
  const archived: string[] = [];
  try {
    renameSync(nextIndex, indexPath);
    writeFileSync(transactionPath, `${JSON.stringify({ inbox, processedDir, files, phase: 'committed' }, null, 2)}\n`, { mode: 0o600 });
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
  kv('index', indexPath);
});
