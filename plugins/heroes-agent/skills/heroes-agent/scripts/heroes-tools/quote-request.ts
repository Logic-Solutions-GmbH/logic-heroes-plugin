/**
 * quote-request — answer an open RFQ with a price (provider / taker side).
 *
 * The RFQ provider (assignee/taker) responds to a REQUESTED (or COUNTERED) RFQ
 * by posting a QUOTED step, attaching the quote document (a PDF carrying the
 * rate) and recording our providerRef. Drives the instance REQUESTED|COUNTERED
 * → QUOTED. A folder attaches a document; --message records a short inline note.
 *
 * Usage:
 *   npx tsx quote-request.ts <serviceId> [<payload-folder>] --provider-ref <ref> \
 *       [--message "<text>"] [--name <eventName>] [--lo-code <UNLOCODE>]
 *
 * Example:
 *   npx tsx quote-request.ts 0cbe6011-... ./quote --provider-ref SCHMX-Q-0042
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
  const providerRef = flagString(flags, 'provider-ref');
  const message = flagString(flags, 'message');
  const name = flagString(flags, 'name') ?? 'Quotation Provided';
  const loCode = flagString(flags, 'lo-code');

  if (!serviceId || !providerRef) {
    throw new Error(
      'Usage: npx tsx quote-request.ts <serviceId> [<payload-folder>] --provider-ref <ref> ' +
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
      filename: 'quote.txt',
      ext: 'txt',
      contentType: 'text/plain',
      data: Buffer.from(message, 'utf8'),
    };
  }

  heading(`Quoting request → providerRef ${providerRef}`);
  const { event, attachmentMode } = await createEventWithAttachment(config, {
    serviceId,
    apiKey,
    event: {
      name,
      loCode,
      strategy: { strategyKey: 'RFQ', stepKey: 'QUOTED', providerRef },
    },
    payload,
  });
  kv('serviceId', serviceId);
  kv('eventId', event.id);
  kv('providerRef', providerRef);
  if (message) kv('message', message);
  if (payload) kv('attachment', `${payload.filename} (${attachmentMode})`);
});
