/**
 * request-quotation — open an RFQ on a NEW shipment (assigner / maker side).
 *
 * Creates a SHIPMENT journey, creates a service on it, then opens an RFQ by
 * posting a REQUESTED event addressed to the target (provider) tenant,
 * attaching the single payload file found in the given folder.
 *
 * Usage:
 *   npx tsx request-quotation.ts <payload-folder> --target <tenantKey> \
 *       [--journey-id <id>] [--service-key <key>] [--name <eventName>] \
 *       [--lo-code <UNLOCODE>]
 *
 * Example:
 *   npx tsx request-quotation.ts ./intake --target schryver-mx \
 *       --service-key ltl_pickup_origin --name "RFQ - Origin Pickup TSN-IOA"
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
  const existingJourneyId = flagString(flags, 'journey-id');
  const serviceKey = flagString(flags, 'service-key') ?? 'ltl_pickup_origin';
  const name = flagString(flags, 'name') ?? 'Quotation Request';
  const loCode = flagString(flags, 'lo-code');

  if ('journey-id' in flags && !existingJourneyId?.trim()) {
    throw new Error('--journey-id requires a value');
  }
  if (!folder || !target) {
    throw new Error(
      'Usage: npx tsx request-quotation.ts <payload-folder> --target <tenantKey> ' +
        '[--journey-id <id>] [--service-key <key>] [--name <eventName>] ' +
        '[--lo-code <UNLOCODE>]',
    );
  }

  const apiKey = requireApiKey(config);
  const payload = readPayloadFolder(folder);

  let journeyId = existingJourneyId;
  if (journeyId) {
    heading('Using existing shipment journey');
  } else {
    heading('Creating shipment journey');
    const journey = await api<any>(config, {
      method: 'POST',
      path: '/journeys',
      apiKey,
      body: { type: 'SHIPMENT' },
    });
    journeyId = journey.id;
  }
  kv('journeyId', journeyId);

  heading('Creating service');
  const service = await api<any>(config, {
    method: 'POST',
    path: '/services',
    apiKey,
    body: { serviceKey, journeyId },
  });
  kv('serviceId', service.id);
  kv('serviceKey', serviceKey);

  heading(`Requesting quotation → ${target}`);
  const { event, attachmentMode } = await createEventWithAttachment(config, {
    serviceId: service.id,
    apiKey,
    event: {
      name,
      loCode,
      strategy: { strategyKey: 'RFQ', stepKey: 'REQUESTED', targetTenantKey: target },
    },
    payload,
  });
  kv('eventId', event.id);
  kv('attachment', `${payload.filename} (${attachmentMode})`);

  heading('Done');
  kv('serviceId', service.id);
  console.log(`\n  Target tenant "${target}" can now quote with a QUOTED step on this RFQ.`);
  console.log(`  Verify with: npx tsx service-status.ts ${service.id}\n`);
});
