/**
 * counter-quotation — counter an open RFQ quote by service ID (requester side).
 *
 * The RFQ requester pushes the strategy instance from QUOTED back to
 * COUNTERED with a message (rate counter-offer, terms, etc.) carried as the
 * event text. Small text rides inline on the event automatically; pass a
 * folder instead of --message to attach a document.
 *
 * Usage:
 *   npx tsx counter-quotation.ts <serviceId> --message "<text>" \
 *       [<payload-folder>] [--name <eventName>] [--lo-code <UNLOCODE>]
 *
 * Example:
 *   npx tsx counter-quotation.ts 0cbe6011-... --message "We can pay USD 8,000, not more."
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
  const name = flagString(flags, 'name') ?? 'Quotation Countered';
  const loCode = flagString(flags, 'lo-code');

  if (!serviceId || (!message && !folder)) {
    throw new Error(
      'Usage: npx tsx counter-quotation.ts <serviceId> --message "<text>" ' +
        '[<payload-folder>] [--name <eventName>] [--lo-code <UNLOCODE>]',
    );
  }

  const apiKey = requireApiKey(config);

  // A folder takes precedence; otherwise --message becomes an inline text payload.
  let payload: Payload | undefined;
  if (folder) {
    payload = readPayloadFolder(folder);
  } else if (message) {
    payload = {
      filename: 'counter-offer.txt',
      ext: 'txt',
      contentType: 'text/plain',
      data: Buffer.from(message, 'utf8'),
    };
  }

  heading('Countering quotation');
  const { event, attachmentMode } = await createEventWithAttachment(config, {
    serviceId,
    apiKey,
    event: {
      name,
      loCode,
      strategy: { strategyKey: 'RFQ', stepKey: 'COUNTERED' },
    },
    payload,
  });
  kv('serviceId', serviceId);
  kv('eventId', event.id);
  if (message) kv('message', message);
  if (payload) kv('attachment', `${payload.filename} (${attachmentMode})`);
});
