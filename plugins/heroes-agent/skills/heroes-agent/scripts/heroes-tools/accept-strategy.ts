/**
 * accept-strategy — accept a handshake by service ID (assignee / taker side).
 *
 * The target tenant accepts an open HANDSHAKE, supplying its own provider
 * reference, and optionally attaches a payload file (e.g. a confirmation
 * document). Only the target tenant may accept — enforced server-side.
 *
 * Usage:
 *   npx tsx accept-strategy.ts <serviceId> --provider-ref <ref> \
 *       [<payload-folder>] [--name <eventName>] [--lo-code <UNLOCODE>]
 *
 * Example:
 *   npx tsx accept-strategy.ts 550e8400-... --provider-ref PROV-12345 \
 *       ./payloads/handshake/accept
 */
import {
  run,
  parseArgs,
  flagString,
  requireApiKey,
  readPayloadFolder,
  createEventWithAttachment,
  heading,
  kv,
} from './lib';

run(async (config) => {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const serviceId = positional[0];
  const folder = positional[1];
  const providerRef = flagString(flags, 'provider-ref');
  const name = flagString(flags, 'name') ?? 'Service Request Accepted';
  const loCode = flagString(flags, 'lo-code');

  if (!serviceId || !providerRef) {
    throw new Error(
      'Usage: npx tsx accept-strategy.ts <serviceId> --provider-ref <ref> ' +
        '[<payload-folder>] [--name <eventName>] [--lo-code <UNLOCODE>]',
    );
  }

  const apiKey = requireApiKey(config);
  const payload = folder ? readPayloadFolder(folder) : undefined;

  heading('Accepting handshake');
  const { event, attachmentMode } = await createEventWithAttachment(config, {
    serviceId,
    apiKey,
    event: {
      name,
      loCode,
      strategy: { strategyKey: 'HANDSHAKE', stepKey: 'ACCEPTED', providerRef },
    },
    payload,
  });
  kv('serviceId', serviceId);
  kv('eventId', event.id);
  kv('providerRef', providerRef);
  if (payload) kv('attachment', `${payload.filename} (${attachmentMode})`);
});
