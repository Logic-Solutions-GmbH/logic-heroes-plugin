/**
 * find-rate — look up a rate for a lane in the provider's rate-book.
 *
 * The retrieval half of the rate-book: given a lane (and optionally equipment,
 * carrier, validity date) it scans the canonical index and returns the best
 * match + provenance, or reports no match. This is what lets the taker QUOTE an
 * RFQ without asking the human — the agent calls this, and only escalates when
 * there's no match. It reads just the index, never the original rate sheet.
 *
 * Exit codes: 0 = matched, 3 = no match, 2 = no rate-book found.
 *
 * Usage:
 *   npx tsx find-rate.ts --origin <LOCODE> --dest <LOCODE> \
 *       [--equipment <type>] [--carrier <name>] [--date <YYYY-MM-DD>] \
 *       [--index <path>] [--aliases <path>] [--limit <n>] [--json]
 *
 * Example:
 *   npx tsx find-rate.ts --origin NLRTM --dest USNYC --equipment 40HC --date 2026-07-20
 */
import {
  run,
  parseArgs,
  flagString,
  csvToObjects,
  loadAliases,
  matchRates,
  heading,
  kv,
  type RateRow,
  type RateQuery,
} from './lib';
import { existsSync, readFileSync } from 'node:fs';

run(async () => {
  const { flags } = parseArgs(process.argv.slice(2));
  const origin = flagString(flags, 'origin');
  const dest = flagString(flags, 'dest');
  const equipment = flagString(flags, 'equipment');
  const carrier = flagString(flags, 'carrier');
  const date = flagString(flags, 'date');
  const indexPath = flagString(flags, 'index') ?? 'self/rate-book/index/rate-book.csv';
  const aliasesPath = flagString(flags, 'aliases') ?? 'self/rate-book/index/aliases.csv';
  const limit = Number(flagString(flags, 'limit') ?? '5');
  const jsonOnly = flags.json === true;

  if (!origin || !dest) {
    throw new Error(
      'Usage: npx tsx find-rate.ts --origin <LOCODE> --dest <LOCODE> ' +
        '[--equipment <type>] [--carrier <name>] [--date <YYYY-MM-DD>] [--index <path>]',
    );
  }

  if (!existsSync(indexPath)) {
    console.log(
      JSON.stringify(
        {
          match: false,
          confidence: 'none',
          reason: `no rate-book at ${indexPath} — run ingest-rates first`,
          best: null,
          candidates: [],
        },
        null,
        2,
      ),
    );
    process.exit(2);
  }

  const rows = csvToObjects(readFileSync(indexPath, 'utf8')) as unknown as RateRow[];
  const aliases = loadAliases(aliasesPath);
  const q: RateQuery = { origin, dest, equipment, carrier, date };
  const m = matchRates(rows, q, aliases);
  const top = m.candidates.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 5);

  const result = {
    match: m.best !== null,
    confidence: m.confidence,
    query: q,
    reasons: m.reasons,
    best: m.best,
    candidates: top,
  };

  if (!jsonOnly) {
    heading(`Rate lookup ${origin} → ${dest}`);
    kv('equipment', equipment ?? '(any)');
    if (carrier) kv('carrier', carrier);
    if (date) kv('date', date);
    kv('index rows', rows.length);

    heading(m.best ? `Match (${m.confidence})` : 'No match');
    for (const r of m.reasons) console.log(`  • ${r}`);
    if (m.best) {
      kv('price', `${m.best.price} ${m.best.currency}`.trim());
      kv('equipment', m.best.equipment || '(unspecified)');
      if (m.best.carrier) kv('carrier', m.best.carrier);
      if (m.best.validFrom || m.best.validTo) kv('validity', `${m.best.validFrom || '…'} → ${m.best.validTo || '…'}`);
      if (m.best.surcharges) kv('surcharges', m.best.surcharges);
      kv('source', `${m.best.sourceFile} (${m.best.sourceRef})`);
      if (top.length > 1) kv('alternatives', `${top.length - 1} more on this lane`);
    } else {
      console.log('  → escalate to the human: no rate on file for this lane.');
    }
    console.log('');
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(m.best ? 0 : 3);
});
