import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  csvToObjects,
  loadAliases,
  matchRates,
  normalizeRateRecord,
  parseArgs,
  parseCsv,
  readPayloadFolder,
  stringifyCsv,
  type RateRow,
} from '../lib';

test('CSV parser preserves quoted commas, quotes, and newlines', () => {
  const source = 'a,b\n"x,y","say ""hi"""\n"two\nlines",z\n';
  const rows = parseCsv(source);
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['x,y', 'say "hi"'],
    ['two\nlines', 'z'],
  ]);
  assert.deepEqual(parseCsv(stringifyCsv(rows)), rows);
});

test('normalization and alias-aware matching select the cheapest valid rate', () => {
  const provenance = { sourceFile: 'rates.csv', sourceRef: 'filed-1', ingestedAt: '2026-08-06T00:00:00Z' };
  const first = normalizeRateRecord({ POL: 'Rotterdam', POD: 'New York', Container: '40HQ', Rate: '8100', Currency: 'USD', 'Valid From': '2026-07-01', 'Valid To': '2026-09-30' }, provenance);
  const second = normalizeRateRecord({ origin: 'NLRTM', dest: 'USNYC', equipment: '40HC', price: '8000', currency: 'USD', validFrom: '2026-07-01', validTo: '2026-09-30' }, provenance);
  assert.ok(first && second);
  const dir = mkdtempSync(join(tmpdir(), 'heroes-aliases-'));
  const aliasesPath = join(dir, 'aliases.csv');
  writeFileSync(aliasesPath, 'type,alias,canonical\nport,Rotterdam,NLRTM\nport,New York,USNYC\nequipment,40HQ,40HC\n');
  const result = matchRates([first, second] as RateRow[], { origin: 'Rotterdam', dest: 'New York', equipment: '40HQ', date: '2026-08-01' }, loadAliases(aliasesPath));
  assert.equal(result.confidence, 'exact');
  assert.equal(result.best?.price, '8000');
});

test('argument parser handles values, booleans, and positionals', () => {
  assert.deepEqual(parseArgs(['service-1', '--json', '--timeout', '5']), {
    positional: ['service-1'],
    flags: { json: true, timeout: '5' },
  });
});

test('payload folders enforce exactly one non-hidden file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heroes-payload-'));
  writeFileSync(join(dir, '.ignored'), 'x');
  assert.throws(() => readPayloadFolder(dir), /No payload file/);
  writeFileSync(join(dir, 'one.txt'), 'hello');
  assert.equal(readPayloadFolder(dir).filename, 'one.txt');
  writeFileSync(join(dir, 'two.txt'), 'world');
  assert.throws(() => readPayloadFolder(dir), /Expected exactly one payload file/);
});
