/**
 * create-shipment — the flagship end-to-end example (assigner / maker side).
 *
 * Creates a SHIPMENT journey, creates a service on it, then opens a HANDSHAKE
 * by posting an INITIATED event addressed to the target tenant, attaching the
 * single payload file found in the given folder.
 *
 * Usage:
 *   npx tsx create-shipment.ts <payload-folder> --target <tenantKey> \
 *       [--service-key <key>] [--name <eventName>] [--lo-code <UNLOCODE>]
 *
 * Example:
 *   npx tsx create-shipment.ts ./payloads/handshake/request-service \
 *       --target schryver --service-key ltl_pickup_origin
 */
import {
  run,
  parseArgs,
  flagString,
  requireApiKey,
  api,
  readPayloadFolder,
  createEventWithAttachment,
  heading,
  kv,
} from './lib';

run(async (config) => {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const folder = positional[0];
  const target = flagString(flags, 'target');
  const serviceKey = flagString(flags, 'service-key') ?? 'OCEAN_FREIGHT';
  const name = flagString(flags, 'name') ?? 'Service Request';
  const loCode = flagString(flags, 'lo-code');

  if (!folder || !target) {
    throw new Error(
      'Usage: npx tsx create-shipment.ts <payload-folder> --target <tenantKey> ' +
        '[--service-key <key>] [--name <eventName>] [--lo-code <UNLOCODE>]',
    );
  }

  const apiKey = requireApiKey(config);
  const payload = readPayloadFolder(folder);

  heading('Creating shipment journey');
  const journey = await api<any>(config, {
    method: 'POST',
    path: '/journeys',
    apiKey,
    body: { type: 'SHIPMENT' },
  });
  kv('journeyId', journey.id);

  heading('Creating service');
  const service = await api<any>(config, {
    method: 'POST',
    path: '/services',
    apiKey,
    body: { serviceKey, journeyId: journey.id },
  });
  kv('serviceId', service.id);
  kv('serviceKey', serviceKey);

  heading(`Initiating handshake → ${target}`);
  const { event, attachmentMode } = await createEventWithAttachment(config, {
    serviceId: service.id,
    apiKey,
    event: {
      name,
      loCode,
      strategy: { strategyKey: 'HANDSHAKE', stepKey: 'INITIATED', targetTenantKey: target },
    },
    payload,
  });
  kv('eventId', event.id);
  kv('attachment', `${payload.filename} (${attachmentMode})`);

  heading('Done');
  kv('serviceId', service.id);
  console.log(`\n  Target tenant "${target}" can now accept with:`);
  console.log(`    npx tsx accept-strategy.ts ${service.id} --provider-ref <ref>\n`);
});
