/**
 * watch-service — block until a counterparty moves, then exit.
 *
 * This is what makes the Workspace interrupt-driven instead of poll-by-hand.
 * After you make an outbound move (RFQ REQUESTED / COUNTERED, HANDSHAKE
 * INITIATED, …) you launch this in the BACKGROUND. It snapshots the service,
 * then re-polls every `--interval` seconds. The moment the strategy step
 * changes OR a new attachment appears, it auto-downloads any new attachments,
 * prints a JSON summary of exactly what changed, and exits 0 — which re-wakes
 * the agent with the news. No human "did they answer yet?" turn required.
 *
 * Exit codes: 0 = something changed (see JSON), 3 = timed out with no change.
 *
 * Usage:
 *   npx tsx watch-service.ts <serviceId> [--interval <sec>] [--timeout <sec>] \
 *       [--download-dir <path>]
 *
 * Example (background):
 *   npx tsx watch-service.ts 0cbe6011-... --interval 15 --timeout 3600 \
 *       --download-dir ./counterparties/schryver-mx
 */
import {
  run,
  parseArgs,
  flagString,
  requireApiKey,
  fetchSnapshot,
  downloadAttachment,
  sleep,
  heading,
  kv,
  type ServiceSnapshot,
} from './lib';

function stepMap(snap: ServiceSnapshot): Record<string, string> {
  const m: Record<string, string> = {};
  for (const i of snap.instances) m[i.id] = `${i.strategyKey}/${i.stepKey}`;
  return m;
}

run(async (config) => {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const serviceId = positional[0];
  const interval = Number(flagString(flags, 'interval') ?? '15');
  const timeout = Number(flagString(flags, 'timeout') ?? '3600');
  const downloadDir = flagString(flags, 'download-dir') ?? process.cwd();

  if (!serviceId) {
    throw new Error(
      'Usage: npx tsx watch-service.ts <serviceId> [--interval <sec>] ' +
        '[--timeout <sec>] [--download-dir <path>]',
    );
  }

  const apiKey = requireApiKey(config);

  // Baseline = the state we just created; we watch for the counterparty's reply.
  const base = await fetchSnapshot(config, apiKey, serviceId);
  const baseSteps = stepMap(base);
  const baseAttIds = new Set(base.attachments.map((a) => a.id));
  heading(`Watching ${serviceId}`);
  kv('baseline', Object.values(baseSteps).join(', ') || '(no strategy)');
  kv('interval', `${interval}s`);
  kv('timeout', `${timeout}s`);

  const deadline = Date.now() + timeout * 1000;
  // Date.now() drives only the local poll clock; nothing persisted depends on it.
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const now = await fetchSnapshot(config, apiKey, serviceId);
    const nowSteps = stepMap(now);

    const stepChanges = Object.keys(nowSteps)
      .filter((id) => nowSteps[id] !== baseSteps[id])
      .map((id) => ({ instanceId: id, from: baseSteps[id] ?? '(new)', to: nowSteps[id] }));

    const newAtts = now.attachments.filter((a) => !baseAttIds.has(a.id));

    if (stepChanges.length === 0 && newAtts.length === 0) {
      process.stderr.write(`  … no change (${new Date().toISOString()})\n`);
      continue;
    }

    // Something moved — pull down any fresh documents so they're on disk already.
    const downloaded: { file: string; path: string }[] = [];
    for (const a of newAtts) {
      const path = await downloadAttachment(config, apiKey, a, downloadDir);
      downloaded.push({ file: a.filename, path });
    }

    heading('Change detected');
    for (const c of stepChanges) kv('step', `${c.from} → ${c.to}`);
    for (const d of downloaded) kv('downloaded', d.path);

    console.log(
      '\n' +
        JSON.stringify(
          {
            changed: true,
            serviceId,
            stepChanges,
            newAttachments: downloaded,
            steps: nowSteps,
          },
          null,
          2,
        ),
    );
    process.exit(0);
  }

  console.log(
    '\n' + JSON.stringify({ changed: false, serviceId, reason: 'timeout', timeout }, null, 2),
  );
  process.exit(3);
});
