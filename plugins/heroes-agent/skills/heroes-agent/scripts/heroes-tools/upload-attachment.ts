/**
 * upload-attachment — add one file to an existing event without a strategy move.
 *
 * Usage:
 *   npx tsx upload-attachment.ts <event-id> <payload-folder>
 */
import {
  run,
  requireApiKey,
  readPayloadFolder,
  uploadAttachment,
  heading,
  kv,
} from './lib';

run(async (config) => {
  const [eventId, folder] = process.argv.slice(2);
  if (!eventId || !folder) {
    throw new Error('Usage: npx tsx upload-attachment.ts <event-id> <payload-folder>');
  }

  const apiKey = requireApiKey(config);
  const payload = readPayloadFolder(folder);

  heading('Uploading attachment');
  await uploadAttachment(config, apiKey, eventId, payload);
  kv('eventId', eventId);
  kv('attachment', `${payload.filename} (multipart)`);
});
