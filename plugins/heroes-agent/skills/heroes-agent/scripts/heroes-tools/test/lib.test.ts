import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  csvToObjects,
  parseArgs,
  parseCsv,
  readPayloadFolder,
  stringifyCsv,
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
