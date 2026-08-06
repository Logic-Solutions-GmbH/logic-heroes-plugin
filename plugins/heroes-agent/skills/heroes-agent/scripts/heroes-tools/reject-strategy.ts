/**
 * reject-strategy — reject a handshake by service ID (assignee / taker side).
 *
 * The target tenant rejects an open HANDSHAKE. This clears the tentative
 * assignment so the maker can retry with another tenant. Optionally attach a
 * payload file, or pass a short --reason (recorded inline as the event text).
 * Only the target tenant may reject — enforced server-side.
 *
 * Usage:
 *   npx tsx reject-strategy.ts <serviceId> [<payload-folder>] \
 *       [--reason <text>] [--name <eventName>] [--lo-code <UNLOCODE>]
 *
 * Example:
 *   npx tsx reject-strategy.ts 550e8400-... --reason "No capacity this week"
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
  type Payload,
} from './lib';

run(async (config) => {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const serviceId = positional[0];
  const folder = positional[1];
  const reason = flagString(flags, 'reason');
  const name = flagString(flags, 'name') ?? 'Service Request Rejected';
  const loCode = flagString(flags, 'lo-code');

  if (!serviceId) {
    throw new Error(
      'Usage: npx tsx reject-strategy.ts <serviceId> [<payload-folder>] ' +
        '[--reason <text>] [--name <eventName>] [--lo-code <UNLOCODE>]',
    );
  }

  const apiKey = requireApiKey(config);

  // A folder takes precedence; otherwise a --reason becomes an inline text payload.
  let payload: Payload | undefined;
  if (folder) {
    payload = readPayloadFolder(folder);
  } else if (reason) {
    payload = {
      filename: 'rejection-reason.txt',
      ext: 'txt',
      contentType: 'text/plain',
      data: Buffer.from(reason, 'utf8'),
    };
  }

  heading('Rejecting handshake');
  const { event, attachmentMode } = await createEventWithAttachment(config, {
    serviceId,
    apiKey,
    event: {
      name,
      loCode,
      strategy: { strategyKey: 'HANDSHAKE', stepKey: 'REJECTED' },
    },
    payload,
  });
  kv('serviceId', serviceId);
  kv('eventId', event.id);
  if (reason) kv('reason', reason);
  if (payload) kv('attachment', `${payload.filename} (${attachmentMode})`);
});
