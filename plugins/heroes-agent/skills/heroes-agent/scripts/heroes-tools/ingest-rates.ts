/**
 * ingest-rates — normalize deposited rate sheets into the canonical rate-book.
 *
 * A provider peer drops its price lists into `self/rate-book/inbox/`; this reads
 * each CSV, maps arbitrary column names to the canonical schema (lane, equipment,
 * price, validity, …), stamps provenance (source file + ref + timestamp), appends
 * the rows to `self/rate-book/index/rate-book.csv`, and archives the original to
 * `self/rate-book/processed/`. Parsing happens ONCE here so retrieval never
 * re-opens the source — and nothing large ever lands in the agent's context.
 *
 * Only CSV is handled in this cut; xlsx / PDF / email are reported and left in
 * place for a later ingestion adapter.
 *
 * Usage:
 *   npx tsx ingest-rates.ts [<inbox-dir>] [--index <path>] [--processed <dir>] \
 *       [--source-ref <ref>] [--dry-run]
 *
 * Example:
 *   npx tsx ingest-rates.ts                 # uses self/rate-book/* defaults
 */
import {
  run,
  parseArgs,
  flagString,
  csvToObjects,
  normalizeRateRecord,
  objectsToCsv,
  RATE_COLUMNS,
  heading,
  kv,
  type RateRow,
} from './lib';
import {
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';

run(async () => {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const inbox = positional[0] ?? flagString(flags, 'inbox') ?? 'self/rate-book/inbox';
  const indexPath = flagString(flags, 'index') ?? 'self/rate-book/index/rate-book.csv';
  const processedDir = flagString(flags, 'processed') ?? 'self/rate-book/processed';
  const sourceRefFlag = flagString(flags, 'source-ref');
  const dryRun = flags['dry-run'] === true;

  if (!existsSync(inbox)) {
    throw new Error(`Inbox not found: ${inbox}. Create it and drop rate sheets in, or pass a path.`);
  }
  const files = readdirSync(inbox).filter(
    (f) => !f.startsWith('.') && statSync(join(inbox, f)).isFile(),
  );
  if (files.length === 0) {
    heading('Nothing to ingest');
    kv('inbox', inbox);
    console.log('  (drop a .csv rate sheet in the inbox first)');
    return;
  }

  const ingestedAt = new Date().toISOString();
  const allNew: RateRow[] = [];
  const report: { file: string; rows: number; skipped: number; status: string; handled: boolean }[] = [];

  for (const file of files) {
    const ext = extname(file).slice(1).toLowerCase();
    const path = join(inbox, file);
    const sizeMB = statSync(path).size / (1024 * 1024);
    if (ext !== 'csv') {
      report.push({
        file,
        rows: 0,
        skipped: 0,
        handled: false,
        status: `skipped (only CSV in this cut; ${ext || 'no-ext'} not yet supported)`,
      });
      continue;
    }
    if (sizeMB > 25) {
      heading(`⚠ ${file} is ${sizeMB.toFixed(1)}MB — parsing may be slow; consider splitting the sheet`);
    }
    const objs = csvToObjects(readFileSync(path, 'utf8'));
    const sourceRef = sourceRefFlag ?? basename(file, extname(file));
    let ok = 0;
    let skip = 0;
    for (const o of objs) {
      const row = normalizeRateRecord(o, { sourceFile: file, sourceRef, ingestedAt });
      if (row) {
        allNew.push(row);
        ok++;
      } else skip++;
    }
    report.push({
      file,
      rows: ok,
      skipped: skip,
      handled: true,
      status: ok ? 'ingested' : 'no lane rows found (need origin + dest columns)',
    });
  }

  heading('Ingestion report');
  for (const r of report) {
    kv(r.file, `${r.rows} rows${r.skipped ? `, ${r.skipped} skipped` : ''} — ${r.status}`);
  }

  if (dryRun) {
    heading('Dry run — index not written, files left in inbox');
    kv('would add', `${allNew.length} rows`);
    return;
  }

  if (allNew.length > 0) {
    mkdirSync(dirname(indexPath), { recursive: true });
    const csv = objectsToCsv(allNew as unknown as Record<string, unknown>[], RATE_COLUMNS as string[]);
    if (!existsSync(indexPath)) {
      writeFileSync(indexPath, csv);
    } else {
      // Append data rows only (drop the header line).
      appendFileSync(indexPath, csv.split('\n').slice(1).join('\n'));
    }
  }

  // Archive the originals we actually parsed; leave unsupported files in the inbox.
  mkdirSync(processedDir, { recursive: true });
  for (const r of report) {
    if (r.handled) renameSync(join(inbox, r.file), join(processedDir, r.file));
  }

  heading('Done');
  kv('index', indexPath);
  kv('rows added', allNew.length);
  kv('processed →', processedDir);
});
