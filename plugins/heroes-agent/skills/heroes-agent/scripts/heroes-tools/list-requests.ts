/**
 * list-requests — discover HANDSHAKE requests, either direction.
 *
 * - `--direction incoming` — HANDSHAKE requests addressed to you.
 * - `--direction outgoing` — HANDSHAKE requests you've sent and their status.
 *
 * The current Heroes requests endpoint does not enumerate RFQ strategies. An
 * RFQ requester must hand the returned service ID to the provider through the
 * existing business channel; the provider then inspects it with service-status.ts.
 *
 * One key, one identity: which direction you ask for is just a query filter,
 * not a different credential (see docs/adr/0002 — maker/taker is per-move).
 *
 * Usage:
 *   npx tsx list-requests.ts --direction incoming|outgoing
 *
 * Example:
 *   npx tsx list-requests.ts --direction incoming
 */
import { run, parseArgs, flagString, requireApiKey, api, heading } from './lib';

run(async (config) => {
  const { flags } = parseArgs(process.argv.slice(2));
  const direction = flagString(flags, 'direction') ?? 'incoming';
  if (direction !== 'incoming' && direction !== 'outgoing' && direction !== 'all') {
    throw new Error('--direction must be one of: incoming, outgoing, all');
  }

  const apiKey = requireApiKey(config);

  heading(`HANDSHAKE requests (${direction})`);
  const data = await api<any>(config, {
    method: 'GET',
    path: '/services/requests',
    apiKey,
    query: { direction },
  });

  const items: any[] = Array.isArray(data)
    ? data
    : (data?.requests ?? data?.instances ?? []);

  if (items.length === 0) {
    console.log('  (none)');
    return;
  }

  for (const it of items) {
    const serviceId = it.serviceId ?? it.service?.id ?? '—';
    const strategy = it.strategyKey ?? it.strategy?.strategyKey ?? 'HANDSHAKE';
    const step = it.currentStepKey ?? it.stepKey ?? it.status ?? '—';
    console.log(`  • ${serviceId}   ${strategy} / ${step}`);
  }
  console.log(`\n  ${items.length} request(s).`);
});
