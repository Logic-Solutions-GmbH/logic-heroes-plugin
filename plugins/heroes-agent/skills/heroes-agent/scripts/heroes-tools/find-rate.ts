/** Deterministic discovery against the versioned Heroes-shaped local rate catalog. */
import { existsSync, readFileSync } from 'node:fs';
import { flagString, heading, kv, parseArgs, run } from './lib';
import {
  discoverRate, type HeroesRateCatalog, type LocationRole, type RateCatalog,
  type RateDiscoveryQuery,
} from './rate-contract';

run(async () => {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const repeated = (name: string): string[] => {
    const values: string[] = [];
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === `--${name}` && argv[index + 1] && !argv[index + 1].startsWith('--')) {
        values.push(argv[index + 1]);
        index++;
      }
    }
    return values;
  };
  const serviceKey = flagString(flags, 'service-key');
  const origins = repeated('origin');
  const destinations = repeated('dest');
  const locations = repeated('location');
  const assetType = flagString(flags, 'asset-type');
  const assetSubtype = flagString(flags, 'asset-subtype');
  const assetValues = repeated('asset');
  const activeOn = flagString(flags, 'date');
  const timeframeValues = repeated('timeframe');
  const participantValues = repeated('participant');
  const strategyKey = flagString(flags, 'strategy');
  const strategyStep = flagString(flags, 'strategy-step');
  const indexPath = flagString(flags, 'index') ?? 'self/rate-book/index/rate-catalog.json';
  const catalogPath = flagString(flags, 'catalog') ?? 'self/rate-book/index/heroes-catalog.json';
  const jsonOnly = flags.json === true;

  const failQuery = (reason: string): never => {
    console.log(JSON.stringify({ status: 'invalid', match: false, reason, candidates: [] }, null, 2));
    process.exit(4);
  };
  const requiredServiceKey = serviceKey ?? failQuery('--service-key is required');
  const locodes: RateDiscoveryQuery['locodes'] = [];
  for (const origin of origins) locodes.push({ code: origin, role: 'origin' });
  for (const destination of destinations) locodes.push({ code: destination, role: 'destination' });
  for (const location of locations) {
    const split = location.lastIndexOf(':');
    if (split < 1 || split === location.length - 1) {
      failQuery('--location must use <code>:<role>');
    }
    locodes.push({ code: location.slice(0, split), role: location.slice(split + 1) as LocationRole });
  }
  const participants: NonNullable<RateDiscoveryQuery['participants']> = [];
  for (const participant of participantValues) {
    const split = participant.lastIndexOf(':');
    if (split < 1 || split === participant.length - 1) {
      failQuery('--participant must use <tenant-key>:<role>');
    }
    participants.push({ tenantKey: participant.slice(0, split), role: participant.slice(split + 1) });
  }
  const strategy = strategyKey ? { strategyKey, currentStep: strategyStep } : undefined;
  if (strategyStep && !strategyKey) failQuery('--strategy-step requires --strategy');
  if (assetSubtype && !assetType) failQuery('--asset-subtype requires --asset-type');
  const assetTypes: NonNullable<RateDiscoveryQuery['assetTypes']> = [];
  if (assetType) assetTypes.push({ type: assetType, subtypes: assetSubtype ? [assetSubtype] : [] });
  for (const value of assetValues) {
    const [type, subtype, extra] = value.split(':');
    if (!type || extra !== undefined) failQuery('--asset must use <type> or <type>:<subtype>');
    const existing = assetTypes.find((asset) => asset.type === type);
    if (existing && subtype && !existing.subtypes.includes(subtype)) existing.subtypes.push(subtype);
    else if (!existing) assetTypes.push({ type, subtypes: subtype ? [subtype] : [] });
  }
  const timeframes: NonNullable<RateDiscoveryQuery['timeframes']> = [];
  if (activeOn) timeframes.push({ from: activeOn, to: activeOn });
  for (const value of timeframeValues) {
    const [from, to, extra] = value.split(':');
    if (extra !== undefined || (!from && !to)) failQuery('--timeframe must use <from>:<to> with either bound allowed');
    timeframes.push({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
  }
  if (!existsSync(indexPath) || !existsSync(catalogPath)) {
    const result = {
      status: 'invalid', match: false,
      reason: `rate index and Heroes catalog are required (${indexPath}; ${catalogPath})`,
      query: { serviceKey: requiredServiceKey, locodes, timeframes, assetTypes, participants, strategy }, candidates: [],
    };
    console.log(JSON.stringify(result, null, 2));
    process.exit(2);
  }

  const query = { serviceKey: requiredServiceKey, locodes, timeframes, assetTypes, participants, strategy };
  let result;
  try {
    const rateCatalog = JSON.parse(readFileSync(indexPath, 'utf8')) as RateCatalog;
    const heroesCatalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as HeroesRateCatalog;
    result = discoverRate(rateCatalog, heroesCatalog, query);
  } catch (error) {
    result = {
      status: 'invalid' as const,
      match: false,
      reason: error instanceof Error ? error.message : 'invalid rate catalog',
      query,
      candidates: [],
    };
  }

  if (!jsonOnly) {
    heading(`Rate discovery: ${requiredServiceKey}`);
    kv('status', result.status);
    kv('reason', result.reason);
    kv('candidates', result.candidates.length);
    if (result.rate) {
      kv('card', result.rate.cardId);
      for (const charge of result.rate.rule.charges) {
        const expression = charge.amount ?? `${charge.tiers?.length ?? 0} tiers`;
        kv(charge.chargeKey, `${expression} ${charge.currency} / ${charge.basis}`);
      }
    }
  }
  console.log(JSON.stringify(result, null, 2));
  // Exit 3 is a valid business decision result. Exit 4 is reserved for invalid input.
  process.exit(result.status === 'matched' ? 0 : result.status === 'invalid' ? 4 : 3);
});
