/** Generic CLI for one peer workspace's local datasets. */
import { readFileSync } from 'node:fs';
import { createDatasetKernel, type DatasetQuery } from './dataset-kernel';
import { parseDatasetManifest } from './dataset-manifest';
import type { DatasetRow } from './dataset-store';
import { openLocalDatasetStore } from './local-dataset-store';
import { flagString, heading, kv, parseArgs, run } from './lib';

type Command = 'define' | 'ingest' | 'query' | 'export';
type Result = Record<string, unknown> & { status: string };

class UsageError extends Error {}

function isCommand(value: string | undefined): value is Command {
  return value === 'define' || value === 'ingest' || value === 'query' || value === 'export';
}

function requireFlag(flags: Record<string, string | boolean>, name: string): string {
  const value = flagString(flags, name);
  if (!value) throw new UsageError(`--${name} is required`);
  return value;
}

function validateArguments(
  command: string | undefined,
  positional: string[],
  flags: Record<string, string | boolean>,
): asserts command is Command {
  if (!isCommand(command)) {
    throw new UsageError('command must be define, ingest, query, or export');
  }
  if (positional.length > 1) throw new UsageError(`unexpected argument: ${positional[1]}`);
  if (flags.json !== undefined && flags.json !== true) throw new UsageError('--json does not take a value');
  const allowed: Record<Command, string[]> = {
    define: ['manifest', 'json'],
    ingest: ['dataset', 'rows', 'json'],
    query: ['dataset', 'field', 'operator', 'value', 'json'],
    export: ['dataset', 'json'],
  };
  const unknown = Object.keys(flags).find((name) => !allowed[command].includes(name));
  if (unknown) throw new UsageError(`unknown flag for ${command}: --${unknown}`);
}

function readJson(path: string, label: string): unknown {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(`${label} file cannot be read: ${reason}`);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} file is not valid JSON: ${reason}`);
  }
}

function parseQueryValue(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return source;
  }
}

function emit(result: Result, jsonOnly: boolean): void {
  if (!jsonOnly) {
    heading(`Local dataset: ${result.status}`);
    for (const name of ['dataset', 'field', 'operator', 'inserted', 'total', 'path', 'reason']) {
      if (result[name] !== undefined) kv(name, result[name]);
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

function failureCode(error: unknown): 2 | 4 {
  if (error instanceof UsageError) return 2;
  const reason = error instanceof Error ? error.message : String(error);
  return reason.startsWith('Dataset is not defined:') ? 2 : 4;
}

run(async () => {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const jsonOnly = flags.json === true;

  try {
    validateArguments(command, positional, flags);
    const kernel = createDatasetKernel(openLocalDatasetStore(process.cwd()));
    let result: Result;

    if (command === 'define') {
      const input = readJson(requireFlag(flags, 'manifest'), 'manifest');
      const manifest = parseDatasetManifest(input);
      await kernel.defineDataset(manifest);
      result = { status: 'defined', dataset: manifest.dataset };
    } else if (command === 'ingest') {
      const dataset = requireFlag(flags, 'dataset');
      const input = readJson(requireFlag(flags, 'rows'), 'rows');
      if (!Array.isArray(input)) throw new Error('rows file must contain a JSON array');
      const outcome = await kernel.ingest(dataset, input as DatasetRow[]);
      result = { status: 'ingested', dataset, ...outcome };
    } else if (command === 'query') {
      const dataset = requireFlag(flags, 'dataset');
      const field = requireFlag(flags, 'field');
      const operator = requireFlag(flags, 'operator');
      if (!['equals', 'one-of', 'range'].includes(operator)) {
        throw new UsageError('--operator must be equals, one-of, or range');
      }
      const query = {
        field,
        operator,
        value: parseQueryValue(requireFlag(flags, 'value')),
      } as DatasetQuery;
      const rows = await kernel.query(dataset, query);
      result = { status: 'queried', dataset, field, operator, total: rows.length, rows };
    } else {
      const dataset = requireFlag(flags, 'dataset');
      const path = await kernel.export(dataset);
      result = { status: 'exported', dataset, path };
    }

    emit(result, jsonOnly);
  } catch (error) {
    const code = failureCode(error);
    const reason = error instanceof Error ? error.message : String(error);
    emit({ status: code === 2 ? 'invalid' : 'refused', command, reason }, jsonOnly);
    process.exitCode = code;
  }
});
