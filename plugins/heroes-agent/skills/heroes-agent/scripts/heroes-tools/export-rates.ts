/** Export the canonical nested rate contract through its stable CSV adapter. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { flagString, heading, kv, parseArgs, run } from './lib';
import { exportRateCsv, validateRateCardApprovals, type RateCatalog } from './rate-contract';

run(async () => {
  const { flags } = parseArgs(process.argv.slice(2));
  const indexPath = flagString(flags, 'index') ?? 'self/rate-book/index/rate-catalog.json';
  const output = flagString(flags, 'output') ?? 'self/rate-book/index/rate-catalog.csv';
  const catalog = JSON.parse(readFileSync(indexPath, 'utf8')) as RateCatalog;
  const issues = validateRateCardApprovals(catalog);
  if (issues.length) throw new Error(issues.join('; '));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, exportRateCsv(catalog), { mode: 0o600 });
  heading('Rate catalog exported');
  kv('input', indexPath);
  kv('output', output);
  kv('cards', catalog.rateCards.length);
});
