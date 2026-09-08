/** Import stable CSV adapter rows into the versioned Heroes-shaped rate catalog. */
import {
  existsSync, readFileSync, readdirSync, statSync,
} from 'node:fs';
import { extname, join } from 'node:path';
import { flagString, heading, kv, parseArgs, run } from './lib';
import { prepareConfiguredRateIngestion } from './rate-store';

run(async () => {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const inbox = positional[0] ?? flagString(flags, 'inbox') ?? 'self/rate-book/inbox';
  const processedDir = flagString(flags, 'processed') ?? 'self/rate-book/processed';
  const approveBy = flagString(flags, 'approve-by');
  const dryRun = flags['dry-run'] === true;
  const openStore = prepareConfiguredRateIngestion(flags, dryRun);
  if (!existsSync(inbox)) throw new Error(`Inbox not found: ${inbox}`);
  const { store, writeLocation, ensureCanArchive, archive } = openStore({ inbox, processedDir });
  const files = readdirSync(inbox).filter((file) =>
    !file.startsWith('.') && statSync(join(inbox, file)).isFile() && extname(file).toLowerCase() === '.csv',
  );
  if (files.length === 0) {
    heading('Nothing to ingest');
    kv('inbox', inbox);
    return;
  }
  const request = {
    sources: files.map((file) => ({
      sourceFile: file,
      csv: readFileSync(join(inbox, file), 'utf8'),
    })),
    approveBy,
    dryRun,
  };
  if (!dryRun) {
    await store.ingestRates({ ...request, dryRun: true });
    ensureCanArchive(files);
  }
  const result = await store.ingestRates(request);

  heading('Rate import');
  kv('files', result.files);
  kv('cards', result.cards);
  kv('catalog hash', result.catalogHash);
  if (result.staleCards) kv('stale cards', `${result.staleCards}; re-approve before use`);
  if (dryRun) {
    kv('status', 'valid; no files changed');
    return;
  }
  archive(files);
  kv('index', writeLocation);
});
