/** Fetch the read-only Heroes catalog values used by the local rate contract. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { flagString, heading, kv, loadConfig, parseArgs, requireApiKey, run } from './lib';
import { fetchHeroesRateCatalog } from './rate-contract';

run(async () => {
  const { flags } = parseArgs(process.argv.slice(2));
  const output = flagString(flags, 'output') ?? 'self/rate-book/index/heroes-catalog.json';
  const config = loadConfig();
  const catalog = await fetchHeroesRateCatalog(config, requireApiKey(config));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });

  heading('Heroes rate catalog saved');
  kv('output', output);
  kv('service keys', catalog.services.length);
  kv('asset types', catalog.assetTypes.length);
  kv('strategies', catalog.strategies.length);
  kv('OpenAPI version', catalog.openApiVersion);
  kv('response hash', catalog.responseHash);
});
