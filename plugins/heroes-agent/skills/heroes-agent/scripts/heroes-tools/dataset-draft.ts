/** Stamp approved draft rows with provenance and approval values from a stored manifest. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDatasetManifest } from './dataset-manifest';
import type { DatasetRow } from './dataset-store';
import { openLocalDatasetStore } from './local-dataset-store';
import { flagString, heading, kv, parseArgs, run } from './lib';

type Result = Record<string, unknown> & { status: string };

class UsageError extends Error {}

function requireFlag(flags: Record<string, string | boolean>, name: string): string {
  const value = flagString(flags, name);
  if (!value) throw new UsageError(`--${name} is required`);
  return value;
}

function validateArguments(
  command: string | undefined,
  positional: string[],
  flags: Record<string, string | boolean>,
): asserts command is 'stamp' {
  if (command !== 'stamp') throw new UsageError('command must be stamp');
  if (positional.length > 1) throw new UsageError(`unexpected argument: ${positional[1]}`);
  if (flags.json !== undefined && flags.json !== true) {
    throw new UsageError('--json does not take a value');
  }
  const allowed = [
    'dataset', 'source', 'source-ref', 'draft', 'approved-by', 'approved-at', 'out', 'json',
  ];
  const unknown = Object.keys(flags).find((name) => !allowed.includes(name));
  if (unknown) throw new UsageError(`unknown flag for stamp: --${unknown}`);
}

function readBytes(path: string, label: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(`${label} file cannot be read: ${reason}`);
  }
}

function readDraft(path: string): unknown {
  const source = readBytes(path, 'draft').toString('utf8');
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(`draft file is not valid JSON: ${reason}`);
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function emit(result: Result, jsonOnly: boolean): void {
  if (!jsonOnly) {
    heading(`Dataset draft: ${result.status}`);
    for (const name of ['dataset', 'rows', 'path', 'sourceHash', 'reason']) {
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
    const dataset = requireFlag(flags, 'dataset');
    const sourcePath = requireFlag(flags, 'source');
    const sourceRef = requireFlag(flags, 'source-ref');
    const draftPath = requireFlag(flags, 'draft');
    const approvedBy = requireFlag(flags, 'approved-by');
    const outputPath = requireFlag(flags, 'out');
    const approvedAt = flagString(flags, 'approved-at') ?? new Date().toISOString();
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(approvedAt)
      || Number.isNaN(Date.parse(approvedAt))
    ) {
      throw new UsageError('--approved-at must be an ISO timestamp');
    }

    const stored = await openLocalDatasetStore(process.cwd()).read(dataset);
    if (!stored) throw new Error(`Dataset is not defined: ${dataset}`);
    const manifest = parseDatasetManifest(stored.manifest);
    const draft = readDraft(draftPath);
    if (!Array.isArray(draft)) throw new Error('draft file must contain a JSON array');

    const sourceHash = sha256(readBytes(sourcePath, 'source'));
    const roleFields = new Set([
      ...Object.values(manifest.provenance),
      ...Object.values(manifest.approval),
    ]);
    const dataFields = manifest.fields
      .map(({ name }) => name)
      .filter((name) => !roleFields.has(name));
    const declaredFields = new Set(manifest.fields.map(({ name }) => name));

    const stamped = draft.map((value, index): DatasetRow => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`draft row ${index + 1} must be an object`);
      }
      const row = value as DatasetRow;
      const reserved = Object.keys(row).find((name) => roleFields.has(name));
      if (reserved) throw new Error(`draft row ${index + 1} carries reserved field: ${reserved}`);
      const unknown = Object.keys(row).find((name) => !declaredFields.has(name));
      if (unknown) throw new Error(`draft row ${index + 1} carries undeclared field: ${unknown}`);

      const data = Object.fromEntries(
        dataFields.flatMap((name) => row[name] === undefined ? [] : [[name, row[name]]]),
      );
      // Canonical JSON is the row's declared fields in manifest order, with every provenance and
      // approval field removed, serialized with JSON.stringify. A second tool can reproduce this hash.
      const contentHash = sha256(JSON.stringify(data));
      return {
        ...data,
        [manifest.provenance.sourceFile]: sourcePath,
        [manifest.provenance.sourceRef]: sourceRef,
        [manifest.provenance.sourceHash]: sourceHash,
        [manifest.approval.status]: 'approved',
        [manifest.approval.approvedBy]: approvedBy,
        [manifest.approval.approvedAt]: approvedAt,
        [manifest.approval.contentHash]: contentHash,
      };
    });

    writeFileSync(outputPath, `${JSON.stringify(stamped, null, 2)}\n`);
    emit({
      status: 'stamped', dataset, rows: stamped.length, path: outputPath, sourceHash,
    }, jsonOnly);
  } catch (error) {
    const code = failureCode(error);
    const reason = error instanceof Error ? error.message : String(error);
    emit({ status: code === 2 ? 'invalid' : 'refused', command, reason }, jsonOnly);
    process.exitCode = code;
  }
});
