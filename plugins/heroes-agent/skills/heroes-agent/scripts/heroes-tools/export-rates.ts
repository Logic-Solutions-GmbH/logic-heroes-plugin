/** Export the canonical nested rate contract through its stable CSV adapter. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { flagString, heading, kv, parseArgs, run } from './lib';
import { exportRateCsv, validateRateCardApprovals } from './rate-contract';
import { openConfiguredRateStore } from './rate-store';

run(async () => {
  const { flags } = parseArgs(process.argv.slice(2));
  const output = flagString(flags, 'output') ?? 'self/rate-book/index/rate-catalog.csv';
  const { store, writeLocation } = openConfiguredRateStore(flags);
  const catalog = await store.listRateCards();
  const issues = validateRateCardApprovals(catalog);
  if (issues.length) throw new Error(issues.join('; '));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, exportRateCsv(catalog), { mode: 0o600 });
  heading('Rate catalog exported');
  kv('input', writeLocation);
  kv('output', output);
  kv('cards', catalog.rateCards.length);
});
