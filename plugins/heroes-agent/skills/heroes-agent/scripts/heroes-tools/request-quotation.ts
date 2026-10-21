/**
 * request-quotation — open an RFQ on a NEW shipment (assigner / maker side).
 *
 * Creates a SHIPMENT journey, creates a service on it, then opens an RFQ by
 * posting a REQUESTED event addressed to the target (provider) tenant,
 * attaching the single payload file found in the given folder.
 *
 * Usage:
 *   npx tsx request-quotation.ts <payload-folder> --target <tenantKey> \
 *       --service-key <key> [--journey-id <id>] [--name <eventName>] \
 *       [--lo-code <UNLOCODE>] [--carriage <json-file>]
 *
 * Example:
 *   npx tsx request-quotation.ts ./intake --target schryver-mx \
 *       --service-key inland_transport --name "RFQ - Origin Pickup TSN-IOA"
 */
import {
  run,
  parseArgs,
  flagString,
  requireApiKey,
  api,
  ApiError,
  apiErrorCode,
  releaseCreatedJourney,
  readPayloadFolder,
  createEventWithAttachment,
  heading,
  kv,
} from './lib';
import { readCarriageFile } from './carriage';

run(async (config) => {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const folder = positional[0];
  const target = flagString(flags, 'target');
  const existingJourneyId = flagString(flags, 'journey-id');
  const serviceKey = flagString(flags, 'service-key');
  const carriagePath = flagString(flags, 'carriage');
  const name = flagString(flags, 'name') ?? 'Quotation Request';
  const loCode = flagString(flags, 'lo-code');

  if ('journey-id' in flags && !existingJourneyId?.trim()) {
    throw new Error('--journey-id requires a value');
  }
  if (!serviceKey?.trim()) {
    throw new Error('--service-key requires a value');
  }
  if ('carriage' in flags && !carriagePath?.trim()) {
    throw new Error('--carriage requires a JSON file');
  }
  if (!folder || !target) {
    throw new Error(
      'Usage: npx tsx request-quotation.ts <payload-folder> --target <tenantKey> ' +
        '--service-key <key> [--journey-id <id>] [--name <eventName>] ' +
        '[--lo-code <UNLOCODE>] [--carriage <json-file>]',
    );
  }

  const carriage = carriagePath ? readCarriageFile(carriagePath, serviceKey) : undefined;
  const apiKey = requireApiKey(config);
  const payload = readPayloadFolder(folder);

  let journeyId = existingJourneyId;
  const createdJourney = !journeyId;
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
  let service: any;
  try {
    service = await api<any>(config, {
      method: 'POST',
      path: '/services',
      apiKey,
      body: { serviceKey, journeyId, ...(carriage ? { carriage } : {}) },
    });
  } catch (error) {
    const code = apiErrorCode(error);
    if (
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      (code === 'CARRIAGE_NOT_ALLOWED' || code === 'CARRIAGE_REQUIRED')
    ) {
      const released = await releaseCreatedJourney(config, {
        journeyId: journeyId!,
        apiKey,
        createdJourney,
      });
      console.log(JSON.stringify({
        status: 'refused',
        reason: code,
        detail: error.message,
        journeyId,
        ...released,
        ...(released.failures.length
          ? { nextStep: 'Release did not finish. Reconcile the journey id by hand before retrying.' }
          : {}),
      }, null, 2));
      process.exitCode = released.failures.length ? 10 : 9;
      return;
    }
    throw error;
  }
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
