/**
 * accept-quotation — accept an open RFQ quote by service ID (requester side).
 *
 * The RFQ requester (assigner/maker) accepts the provider's current quote,
 * driving the instance QUOTED|COUNTERED → ACCEPTED. Optionally attach a
 * document, or pass --message to record a short inline note (e.g. a PO ref).
 *
 * Usage:
 *   npx tsx accept-quotation.ts <serviceId> [<payload-folder>] \
 *       [--message "<text>"] [--name <eventName>] [--lo-code <UNLOCODE>]
 *
 * Example:
 *   npx tsx accept-quotation.ts 0cbe6011-... --message "Accepted at USD 8,000. PO-2026-0042."
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
  const message = flagString(flags, 'message');
  const name = flagString(flags, 'name') ?? 'Quotation Accepted';
  const loCode = flagString(flags, 'lo-code');

  if (!serviceId) {
    throw new Error(
      'Usage: npx tsx accept-quotation.ts <serviceId> [<payload-folder>] ' +
        '[--message "<text>"] [--name <eventName>] [--lo-code <UNLOCODE>]',
    );
  }

  const apiKey = requireApiKey(config);

  // A folder takes precedence; otherwise --message becomes an inline text payload.
  let payload: Payload | undefined;
  if (folder) {
    payload = readPayloadFolder(folder);
  } else if (message) {
    payload = {
      filename: 'acceptance.txt',
      ext: 'txt',
      contentType: 'text/plain',
      data: Buffer.from(message, 'utf8'),
    };
  }

  heading('Accepting quotation');
  const { event, attachmentMode } = await createEventWithAttachment(config, {
    serviceId,
    apiKey,
    event: {
      name,
      loCode,
      strategy: { strategyKey: 'RFQ', stepKey: 'ACCEPTED' },
    },
    payload,
  });
  kv('serviceId', serviceId);
  kv('eventId', event.id);
  if (message) kv('message', message);
  if (payload) kv('attachment', `${payload.filename} (${attachmentMode})`);
});
