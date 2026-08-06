/**
 * service-status — one-shot, full picture of a service.
 *
 * Folds strategies + events + attachments into a single readable dump, so you
 * don't hand-run separate strategies → events → per-event attachments calls.
 * Pass --download to also pull every attachment to disk.
 *
 * Usage:
 *   npx tsx service-status.ts <serviceId> [--download] [--download-dir <path>]
 *
 * Example:
 *   npx tsx service-status.ts 0cbe6011-... --download --download-dir ./counterparties/schryver-mx
 */
import {
  run,
  parseArgs,
  flagString,
  requireApiKey,
  fetchSnapshot,
  downloadAttachment,
  heading,
  kv,
} from './lib';

run(async (config) => {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const serviceId = positional[0];
  const doDownload = flags.download === true;
  const downloadDir = flagString(flags, 'download-dir') ?? process.cwd();

  if (!serviceId) {
    throw new Error(
      'Usage: npx tsx service-status.ts <serviceId> [--download] [--download-dir <path>]',
    );
  }

  const apiKey = requireApiKey(config);
  const snap = await fetchSnapshot(config, apiKey, serviceId);

  heading(`Service ${serviceId}`);
  heading('Strategies');
  if (snap.instances.length === 0) console.log('  (none)');
  for (const i of snap.instances) {
    console.log(`  • ${i.strategyKey} / ${i.stepKey}`);
    kv('instanceId', i.id);
    if (i.startedAt) kv('startedAt', i.startedAt);
  }

  heading('Events (newest last)');
  if (snap.events.length === 0) console.log('  (none)');
  for (const e of snap.events) {
    const from = e.source ?? '—';
    console.log(`  • [${e.id}] ${from}: ${e.name}  (${e.eventAt ?? e.createdAt ?? ''})`);
    for (const a of snap.attachments.filter((x) => x.eventId === e.id)) {
      const kb = a.fileSize ? ` ${(a.fileSize / 1024).toFixed(1)}KB` : '';
      console.log(`      ↳ 📎 [${a.id}] ${a.filename}${kb}`);
    }
  }

  if (doDownload && snap.attachments.length > 0) {
    heading('Downloading attachments');
    for (const a of snap.attachments) {
      const path = await downloadAttachment(config, apiKey, a, downloadDir);
      kv('saved', path);
    }
  }
});
