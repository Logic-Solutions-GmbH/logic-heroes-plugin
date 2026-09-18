import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, posix } from 'node:path';
import { canonicalJson } from './dataset-kernel';
import { compileDatasetPostgres } from './dataset-postgres-compiler';
import type { DatasetManifest } from './dataset-manifest';

export interface DatasetProposalFile {
  path: string;
  sha256: string;
}

export interface DatasetBackupRecord {
  path: string;
  sha256: string;
  rowCount: number;
}

export interface DatasetProposal {
  manifest: DatasetManifest;
  files: DatasetProposalFile[];
  hash: string;
  backup?: DatasetBackupRecord;
}

export interface WriteDatasetProposalOptions {
  workspace: string;
  manifest: unknown;
  tenantKey: string;
  migrationVersion: string;
  previousProposal?: DatasetProposal;
  backup?: DatasetBackupRecord;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function destructiveChanges(previous: DatasetManifest, next: DatasetManifest): string[] {
  const changes: string[] = [];
  const nextFields = new Map(next.fields.map((field) => [field.name, field]));
  for (const field of previous.fields) {
    const replacement = nextFields.get(field.name);
    if (!replacement) changes.push(`removed field ${field.name}`);
    else if (replacement.type !== field.type) {
      changes.push(`changed field ${field.name} type from ${field.type} to ${replacement.type}`);
    } else if (!field.required && replacement.required) {
      changes.push(`made field ${field.name} required`);
    }
  }
  if (canonicalJson(previous.identity) !== canonicalJson(next.identity)) changes.push('changed identity key');
  if (canonicalJson(previous.deduplication) !== canonicalJson(next.deduplication)) {
    changes.push('changed deduplication key');
  }
  return changes;
}

function validateBackup(backup: DatasetBackupRecord): void {
  const normalized = posix.normalize(backup.path);
  if (!backup.path.startsWith('self/supabase/') || normalized !== backup.path) {
    throw new Error(`Backup path must be under self/supabase/: ${backup.path}`);
  }
  if (!/^[0-9a-f]{64}$/.test(backup.sha256)) throw new Error('Backup SHA-256 must be 64 lowercase hex characters');
  if (!Number.isSafeInteger(backup.rowCount) || backup.rowCount < 0) {
    throw new Error('Backup row count must be a non-negative integer');
  }
}

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Build and persist one proposal in a user workspace. SQL is never executed. */
export function writeDatasetProposal(options: WriteDatasetProposalOptions): DatasetProposal {
  const compiled = compileDatasetPostgres(options);
  const changes = options.previousProposal
    ? destructiveChanges(options.previousProposal.manifest, compiled.manifest)
    : [];

  if (changes.length > 0 && !options.backup) {
    throw new Error(`Destructive change requires a backup: ${changes.join('; ')}`);
  }
  if (options.backup) validateBackup(options.backup);

  const files = compiled.files.map((file) => ({ path: file.path, sha256: sha256(file.content) }));
  const hashInput: {
    manifest: DatasetManifest;
    files: DatasetProposalFile[];
    backup?: DatasetBackupRecord;
  } = { manifest: compiled.manifest, files };
  if (options.backup) hashInput.backup = options.backup;
  const proposal: DatasetProposal = {
    ...hashInput,
    hash: sha256(canonicalJson(hashInput)),
  };

  for (const [index, file] of compiled.files.entries()) {
    writePrivate(join(options.workspace, file.path), file.content);
    if (sha256(file.content) !== files[index].sha256) throw new Error(`SQL hash mismatch: ${file.path}`);
  }
  const proposalPath = join(
    options.workspace, 'self', 'supabase', 'datasets', compiled.manifest.dataset, 'proposal.json',
  );
  writePrivate(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
  return proposal;
}
