/**
 * create-shipment — the flagship end-to-end example (assigner / maker side).
 *
 * Creates a SHIPMENT journey, creates a service on it, then opens a HANDSHAKE
 * by posting an INITIATED event addressed to the target tenant, attaching the
 * single payload file found in the given folder.
 *
 * Usage:
 *   npx tsx create-shipment.ts <payload-folder> --target <tenantKey> \
 *       --service-key <key> [--journey-id <id>] [--name <eventName>] \
 *       [--lo-code <UNLOCODE>] [--carriage <json-file>] \
 *       [--collaborator <tenantKey> ...]
 *
 * Example:
 *   npx tsx create-shipment.ts ./payloads/handshake/request-service \
 *       --target example-taker --service-key inland_transport \
 *       --collaborator example-collaborator
 */
import {
  run,
  parseArgs,
  flagString,
  flagValues,
  requireApiKey,
  api,
  ApiError,
  apiErrorCode,
  addServiceCollaborator,
  readPayloadFolder,
  createEventWithAttachment,
  heading,
  kv,
} from './lib';
import { readCarriageFile } from './carriage';

run(async (config) => {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const folder = positional[0];
  const target = flagString(flags, 'target');
  const existingJourneyId = flagString(flags, 'journey-id');
  const serviceKey = flagString(flags, 'service-key');
  const carriagePath = flagString(flags, 'carriage');
  const name = flagString(flags, 'name') ?? 'Service Request';
  const loCode = flagString(flags, 'lo-code');
  const collaboratorKeys = flagValues(argv, 'collaborator').map((key) => key.trim());

  if ('journey-id' in flags && !existingJourneyId?.trim()) {
    throw new Error('--journey-id requires a value');
  }
  if (!serviceKey?.trim()) {
    throw new Error('--service-key requires a value');
  }
  if ('carriage' in flags && !carriagePath?.trim()) {
    throw new Error('--carriage requires a JSON file');
  }
  if (collaboratorKeys.some((key) => !key)) {
    throw new Error('--collaborator requires a value');
  }
  if (!folder || !target) {
    throw new Error(
      'Usage: npx tsx create-shipment.ts <payload-folder> --target <tenantKey> ' +
        '--service-key <key> [--journey-id <id>] [--name <eventName>] ' +
        '[--lo-code <UNLOCODE>] [--carriage <json-file>] ' +
        '[--collaborator <tenantKey> ...]',
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
      let releasedJourney: string | null = null;
      if (createdJourney) {
        await api(config, { method: 'DELETE', path: `/journeys/${journeyId}`, apiKey });
        releasedJourney = journeyId!;
      }
      console.log(JSON.stringify({
        status: 'refused',
        reason: code,
        detail: error.message,
        journeyId,
        releasedJourney,
      }, null, 2));
      process.exitCode = 9;
      return;
    }
    throw error;
  }
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

  if (collaboratorKeys.length > 0) {
    heading('Adding collaborators');
    for (let index = 0; index < collaboratorKeys.length; index++) {
      const tenantKey = collaboratorKeys[index];
      try {
        const result = await addServiceCollaborator(config, {
          serviceId: service.id,
          apiKey,
          tenantKey,
        });
        kv('tenantKey', result.tenantKey);
        kv('collaboratorId', result.id);
        kv('created', result.created);
      } catch (err) {
        const remaining = collaboratorKeys
          .slice(index)
          .map((key) => `--tenant-key ${key}`)
          .join(' ');
        console.error(`\n  serviceId         ${service.id}`);
        console.error(`    npx tsx add-service-collaborator.ts ${service.id} ${remaining}`);
        throw err;
      }
    }
  }

  heading('Done');
  kv('serviceId', service.id);
  console.log(`\n  Target tenant "${target}" can now accept with:`);
  console.log(`    npx tsx accept-strategy.ts ${service.id} --provider-ref <ref>\n`);
});
