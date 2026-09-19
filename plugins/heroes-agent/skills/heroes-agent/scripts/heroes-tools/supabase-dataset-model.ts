import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './dataset-kernel';
import { parseDatasetManifest, type DatasetManifest } from './dataset-manifest';
import { writeDatasetProposal, type DatasetProposal } from './dataset-proposal';
import {
  assertDatasetPostgresVerification, buildDatasetPostgresVerificationQuery,
  readDatasetPostgresVerification, type DatasetVerification,
} from './dataset-postgres-verifier';
import { flagString, parseArgs, run } from './lib';
import {
  applyPush, assertMigrationHistory, dryRunPush, failure, managementRequest, migrationRows,
  prepareMigrations, requireCli, writeAttempt, type SupabaseMigrationFile,
} from './supabase-dataset-store';

interface Binding {
  schemaVersion: '1.0';
  heroesTenantKey: string;
  supabaseProjectRef: string;
  supabaseProjectName: string;
  supabaseRegion: string;
}

interface StoredProposal extends DatasetProposal {
  migrationVersion: string;
}

type Action = 'discover' | 'propose' | 'confirm' | 'install' | 'reload';
type Result = Record<string, unknown> & { status: string; dataset?: string };

class UsageError extends Error {}

const toolsDir = dirname(fileURLToPath(import.meta.url));
const pluginSkillRoot = resolve(toolsDir, '..', '..');
const bootstrapProject = join(pluginSkillRoot, 'assets', 'supabase-project', 'supabase');

function requireFlag(flags: Record<string, string | boolean>, name: string): string {
  const value = flagString(flags, name);
  if (!value) throw new UsageError(`--${name} is required`);
  return value;
}

function readJson(path: string, label: string): unknown {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    throw new UsageError(`${label} file cannot be read: ${path}`);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new UsageError(`${label} file is not valid JSON: ${path}`);
  }
}

function readBinding(): Binding {
  const path = join(process.cwd(), 'self', 'supabase', 'binding.json');
  if (!existsSync(path)) throw failure('project_identity_mismatch', 'Supabase binding is missing.');
  const value = readJson(path, 'Supabase binding') as Partial<Binding>;
  if (
    value.schemaVersion !== '1.0'
    || typeof value.heroesTenantKey !== 'string'
    || typeof value.supabaseProjectRef !== 'string'
    || typeof value.supabaseProjectName !== 'string'
    || typeof value.supabaseRegion !== 'string'
    || !value.supabaseProjectRef
    || !value.supabaseProjectName
    || !value.supabaseRegion
  ) {
    throw failure('project_identity_mismatch', 'Supabase binding is invalid.');
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.heroesTenantKey)) {
    throw new UsageError('Binding tenant key must be normalized lower-case hyphen-case.');
  }
  return value as Binding;
}

function validateArguments(
  action: string | undefined,
  positional: string[],
  flags: Record<string, string | boolean>,
): asserts action is Action {
  if (!['discover', 'propose', 'confirm', 'install', 'reload'].includes(action ?? '')) {
    throw new UsageError('action must be discover, propose, confirm, install, or reload');
  }
  if (positional.length > 1) throw new UsageError(`unexpected argument: ${positional[1]}`);
  if (flags.json !== undefined && flags.json !== true) throw new UsageError('--json does not take a value');
  const allowed: Record<Action, string[]> = {
    discover: ['manifest', 'project-ref', 'json'],
    propose: ['manifest', 'migration-version', 'project-ref', 'json'],
    confirm: ['dataset', 'proposal-hash', 'project-ref', 'json'],
    install: ['dataset', 'proposal-hash', 'project-ref', 'json'],
    reload: ['dataset', 'project-ref', 'json'],
  };
  const unknown = Object.keys(flags).find((name) => !allowed[action as Action].includes(name));
  if (unknown) throw new UsageError(`unknown flag for ${action}: --${unknown}`);
}

function validateProjectRef(binding: Binding, flags: Record<string, string | boolean>): void {
  const projectRef = flagString(flags, 'project-ref');
  if (projectRef && projectRef !== binding.supabaseProjectRef) {
    throw failure('project_identity_mismatch', 'Project ref does not match the workspace binding.');
  }
}

function proposalPath(dataset: string): string {
  return join(process.cwd(), 'self', 'supabase', 'datasets', dataset, 'proposal.json');
}

function confirmedPath(dataset: string): string {
  return join(process.cwd(), 'self', 'supabase', 'datasets', dataset, 'confirmed.json');
}

function attemptPath(): string {
  return join(process.cwd(), 'self', 'supabase', 'migration-attempt.json');
}

function installProjectDir(): string {
  return join(process.cwd(), 'self', 'supabase', 'project');
}

function proposalMigrationVersion(proposal: DatasetProposal): string {
  const datasetDirectory = `self/supabase/datasets/${proposal.manifest.dataset}/migrations/`;
  const legacyDirectory = 'self/supabase/project/supabase/migrations/';
  const versions = new Set(proposal.files.map(({ path }) => {
    const directory = path.startsWith(datasetDirectory) ? datasetDirectory : legacyDirectory;
    if (!path.startsWith(directory)) return undefined;
    return /^(\d{14})_[^/]+\.sql$/.exec(path.slice(directory.length))?.[1];
  }));
  if (versions.size !== 1 || versions.has(undefined)) {
    throw failure('proposal_invalid', 'Dataset proposal does not contain one 14-digit migration version.');
  }
  return [...versions][0]!;
}

function proposalHash(proposal: DatasetProposal): string {
  const hashInput: Record<string, unknown> = {
    manifest: proposal.manifest,
    files: proposal.files,
  };
  if (proposal.backup) hashInput.backup = proposal.backup;
  return createHash('sha256').update(canonicalJson(hashInput)).digest('hex');
}

function writeIsolatedProposal(options: {
  manifest: unknown;
  tenantKey: string;
  migrationVersion: string;
}): DatasetProposal {
  const temporaryWorkspace = mkdtempSync(join(tmpdir(), 'heroes-dataset-proposal-'));
  try {
    const draft = writeDatasetProposal({ workspace: temporaryWorkspace, ...options });
    const files = draft.files.map((file) => {
      const path = `self/supabase/datasets/${draft.manifest.dataset}/migrations/${basename(file.path)}`;
      const target = join(process.cwd(), path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(temporaryWorkspace, file.path)), { mode: 0o600 });
      chmodSync(target, 0o600);
      return { ...file, path };
    });
    const proposal: DatasetProposal = { ...draft, files, hash: '' };
    proposal.hash = proposalHash(proposal);
    writeFileSync(proposalPath(proposal.manifest.dataset), `${JSON.stringify(proposal, null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(proposalPath(proposal.manifest.dataset), 0o600);
    return proposal;
  } finally {
    rmSync(temporaryWorkspace, { recursive: true, force: true });
  }
}

function loadProposal(dataset: string): StoredProposal {
  const value = readJson(proposalPath(dataset), 'dataset proposal') as DatasetProposal;
  const manifest = parseDatasetManifest(value.manifest);
  if (manifest.dataset !== dataset || !Array.isArray(value.files) || value.files.length !== 3) {
    throw failure('proposal_invalid', 'Dataset proposal does not match the requested dataset.');
  }
  const calculatedHash = proposalHash(value);
  if (value.hash !== calculatedHash) {
    throw failure('proposal_invalid', 'Dataset proposal hash is invalid.');
  }
  const migrationVersion = proposalMigrationVersion(value);
  for (const file of value.files) {
    if (!file || typeof file.path !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw failure('proposal_invalid', 'Dataset proposal file evidence is invalid.');
    }
    const path = join(process.cwd(), file.path);
    if (!existsSync(path)) throw failure('proposal_invalid', `Dataset proposal file is missing: ${file.path}.`);
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actual !== file.sha256) {
      throw failure('proposal_invalid', `Dataset proposal file differs: ${file.path}.`);
    }
  }
  return { ...value, manifest, migrationVersion };
}

function migrationFiles(proposal: StoredProposal): SupabaseMigrationFile[] {
  const orderedSuffixes = ['_schema.sql', '_rls.sql', '_functions.sql'];
  const orderedPaths = orderedSuffixes.map((suffix) => {
    const matches = proposal.files.filter(({ path }) => path.endsWith(suffix));
    if (matches.length !== 1) {
      throw failure('proposal_invalid', `Dataset proposal needs one ${suffix.slice(1)} file.`);
    }
    return matches[0].path;
  });
  const content = orderedPaths.map((path) => {
    const source = readFileSync(join(process.cwd(), path), 'utf8');
    return source.endsWith('\n') ? source : `${source}\n`;
  }).join('\n');
  const table = proposal.manifest.dataset.replaceAll('.', '__');
  return [{
    file: `${proposal.migrationVersion}_${table}.sql`,
    content,
    version: proposal.migrationVersion,
  }];
}

function emit(result: Result): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function verification(
  binding: Binding,
  manifest: DatasetManifest,
): Promise<DatasetVerification> {
  const value = await managementRequest({
    action: 'query-read-only',
    projectRef: binding.supabaseProjectRef,
    query: buildDatasetPostgresVerificationQuery(manifest, binding.heroesTenantKey),
  });
  return readDatasetPostgresVerification(value);
}

function writeConfirmed(
  path: string,
  binding: Binding,
  proposal: StoredProposal,
  checked: DatasetVerification,
): void {
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: '1.0',
    dataset: proposal.manifest.dataset,
    heroesTenantKey: binding.heroesTenantKey,
    supabaseProjectRef: binding.supabaseProjectRef,
    migrationVersion: proposal.migrationVersion,
    proposalHash: proposal.hash,
    verification: checked,
    status: 'confirmed',
  }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

run(async () => {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const action = positional[0];
  const resultDataset = flagString(flags, 'dataset');
  try {
    validateArguments(action, positional, flags);
    const binding = readBinding();
    validateProjectRef(binding, flags);

    if (action === 'discover') {
      const manifest = parseDatasetManifest(readJson(requireFlag(flags, 'manifest'), 'manifest'));
      const project = await managementRequest({
        action: 'project', projectRef: binding.supabaseProjectRef,
      }) as Record<string, unknown>;
      if (
        project.ref !== binding.supabaseProjectRef
        || project.name !== binding.supabaseProjectName
        || project.region !== binding.supabaseRegion
      ) {
        throw failure('project_identity_mismatch', 'Live Supabase project does not match the workspace binding.');
      }
      emit({
        status: 'discovered',
        dataset: manifest.dataset,
        binding: {
          heroesTenantKey: binding.heroesTenantKey,
          supabaseProjectRef: binding.supabaseProjectRef,
          supabaseProjectName: binding.supabaseProjectName,
          supabaseRegion: binding.supabaseRegion,
        },
        verification: await verification(binding, manifest),
      });
      return;
    }

    if (action === 'propose') {
      const manifest = readJson(requireFlag(flags, 'manifest'), 'manifest');
      const migrationVersion = requireFlag(flags, 'migration-version');
      if (!/^\d{14}$/.test(migrationVersion)) {
        throw new UsageError('--migration-version must contain exactly 14 digits');
      }
      const proposal = writeIsolatedProposal({
        manifest,
        tenantKey: binding.heroesTenantKey,
        migrationVersion,
      });
      emit({
        status: 'proposed',
        dataset: proposal.manifest.dataset,
        proposalHash: proposal.hash,
        migrationVersion,
        files: proposal.files,
      });
      return;
    }

    const dataset = requireFlag(flags, 'dataset');
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(dataset)) {
      throw new UsageError(`Invalid dataset key: ${dataset}`);
    }
    const proposal = loadProposal(dataset);

    if (action === 'confirm') {
      if (requireFlag(flags, 'proposal-hash') !== proposal.hash) {
        throw failure('proposal_mismatch', 'Proposal hash does not match the current dataset proposal.');
      }
      emit({
        status: 'confirmed', dataset, proposalHash: proposal.hash,
        migrationVersion: proposal.migrationVersion,
      });
      return;
    }

    if (action === 'reload') {
      const path = confirmedPath(dataset);
      if (!existsSync(path)) throw failure('confirmation_missing', 'Confirmed dataset model is missing.');
      const confirmed = readJson(path, 'confirmed dataset model') as Record<string, unknown>;
      if (confirmed.proposalHash !== proposal.hash) {
        throw failure('proposal_mismatch', 'Confirmed dataset model does not match the current proposal.');
      }
      emit({
        status: 'reloaded', dataset, proposalHash: proposal.hash,
        migrationVersion: proposal.migrationVersion,
      });
      return;
    }

    if (requireFlag(flags, 'proposal-hash') !== proposal.hash) {
      throw failure('proposal_mismatch', 'Proposal hash does not match the current dataset proposal.');
    }
    requireCli(toolsDir);
    const attempt = attemptPath();
    if (existsSync(attempt)) {
      throw failure('migration_partial', 'A prior migration attempt requires operator inspection.');
    }
    const attemptRecord = {
      schemaVersion: '1.0',
      dataset,
      heroesTenantKey: binding.heroesTenantKey,
      supabaseProjectRef: binding.supabaseProjectRef,
      migrationVersion: proposal.migrationVersion,
      proposalHash: proposal.hash,
      status: 'staging',
    };
    writeAttempt(attempt, attemptRecord);
    const projectDir = prepareMigrations({
      workspace: process.cwd(),
      bootstrapProject,
      migrations: migrationFiles(proposal),
      projectDir: installProjectDir(),
    });
    const historyOptions = {
      requiredMigrations: [{ version: proposal.migrationVersion }],
      missingRequiredMessage: 'The generated dataset migration did not verify.',
    };
    const before = migrationRows(toolsDir, projectDir, binding.supabaseProjectRef);
    const alreadyApplied = assertMigrationHistory({
      rows: before, requireAll: false, ...historyOptions,
    });
    dryRunPush(toolsDir, projectDir, binding.supabaseProjectRef);
    if (!alreadyApplied) {
      writeAttempt(attempt, { ...attemptRecord, status: 'applying' });
      applyPush(toolsDir, projectDir, binding.supabaseProjectRef);
      assertMigrationHistory({
        rows: migrationRows(toolsDir, projectDir, binding.supabaseProjectRef),
        requireAll: true,
        ...historyOptions,
      });
    }
    const checked = await verification(binding, proposal.manifest);
    assertDatasetPostgresVerification(checked);
    writeConfirmed(confirmedPath(dataset), binding, proposal, checked);
    unlinkSync(attempt);
    emit({
      status: 'installed',
      dataset,
      proposalHash: proposal.hash,
      migrationVersion: proposal.migrationVersion,
      migrationApplied: !alreadyApplied,
      verification: checked,
    });
  } catch (error) {
    const invalid = error instanceof UsageError
      || (!String(errorReason(error)).startsWith('[proposal_')
        && !String(errorReason(error)).startsWith('[project_')
        && !String(errorReason(error)).startsWith('[configuration_')
        && !String(errorReason(error)).startsWith('[migration_')
        && !String(errorReason(error)).startsWith('[verification_')
        && !String(errorReason(error)).startsWith('[confirmation_')
        && !String(errorReason(error)).startsWith('[project_unreachable]'));
    emit({
      status: invalid ? 'invalid' : 'refused',
      ...(typeof action === 'string' ? { action } : {}),
      ...(resultDataset ? { dataset: resultDataset } : {}),
      reason: errorReason(error),
    });
    process.exitCode = invalid ? 2 : 4;
  }
});
