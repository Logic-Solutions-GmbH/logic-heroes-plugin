/** Fetch the read-only Heroes catalog values used by the local rate contract. */
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { flagString, heading, kv, loadConfig, parseArgs, requireApiKey, run } from './lib';
import { fetchHeroesRateCatalog } from './rate-contract';

run(async () => {
  const { flags } = parseArgs(process.argv.slice(2));
  const output = flagString(flags, 'output') ?? 'self/rate-book/index/heroes-catalog.json';
  const config = loadConfig();
  const catalog = await fetchHeroesRateCatalog(config, requireApiKey(config));
  const previousHash = existsSync(output)
    ? (JSON.parse(readFileSync(output, 'utf8')) as { responseHash?: string }).responseHash
    : undefined;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });

  heading('Heroes rate catalog saved');
  kv('output', output);
  kv('service keys', catalog.services.length);
  kv('asset types', catalog.assetTypes.length);
  kv('location roles', catalog.locationRoles.join(', '));
  kv('timeframe kinds', catalog.timeframeKinds.join(', '));
  kv('strategies', catalog.strategies.length);
  kv('OpenAPI version', catalog.openApiVersion);
  kv('response hash', catalog.responseHash);
  if (previousHash && previousHash !== catalog.responseHash) {
    kv('rate approval', 'catalog changed; re-import and re-approve affected cards with ingest-rates.ts --approve-by <name>');
  }
});
