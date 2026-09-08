import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { flagString, heading, kv, parseArgs, run } from './lib';

const PINNED_CLI_VERSION = '2.117.0';
const toolsDir = dirname(fileURLToPath(import.meta.url));
const sourceProject = resolve(toolsDir, '..', '..', 'assets', 'supabase-project');

interface Binding {
  schemaVersion: '1.0';
  heroesTenantKey: string;
  supabaseProjectRef: string;
  supabaseProjectName: string;
  supabaseRegion: string;
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function failure(code: string, message: string): Error {
  return new Error(`[${code}] ${message}`);
}

function readTenantKey(): string {
  const identityPath = join(process.cwd(), 'self', 'identity.md');
  if (!existsSync(identityPath)) {
    throw failure('configuration_missing', 'Heroes tenant identity is missing. Configure self/identity.md first.');
  }
  const identity = readFileSync(identityPath, 'utf8');
  const matches = [...identity.matchAll(/^- \*\*Tenant key:\*\* `([^`]+)`$/gm)];
  if (matches.length !== 1 || !matches[0][1] || matches[0][1] === '<tenant-key>') {
    throw failure('project_binding_ambiguous', 'Heroes tenant identity is missing or ambiguous. Configure one tenant key.');
  }
  return matches[0][1];
}

function requireCredentials(): void {
  if (!process.env.SUPABASE_ACCESS_TOKEN) {
    throw failure('configuration_missing', 'Supabase access token is missing. Set SUPABASE_ACCESS_TOKEN in self/.env.');
  }
  if (!process.env.SUPABASE_DB_PASSWORD) {
    throw failure('configuration_missing', 'Supabase database password is missing. Set SUPABASE_DB_PASSWORD in self/.env.');
  }
}

function cliPath(): string {
  if (process.env.HEROES_SUPABASE_CLI) return process.env.HEROES_SUPABASE_CLI;
  return join(toolsDir, 'node_modules', '.bin', process.platform === 'win32' ? 'supabase.cmd' : 'supabase');
}

function cliEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'COMSPEC', 'PATHEXT',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.SUPABASE_ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
  env.SUPABASE_DB_PASSWORD = process.env.SUPABASE_DB_PASSWORD;
  if (process.env.HEROES_SUPABASE_CLI) {
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('FAKE_SUPABASE_')) env[key] = value;
    }
  }
  return env;
}

function callCli(args: string[]): CliResult {
  const result = spawnSync(cliPath(), args, {
    cwd: process.cwd(),
    env: cliEnvironment(),
    encoding: 'utf8',
  });
  if (result.error) {
    return { status: 127, stdout: '', stderr: result.error.message };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function isAuthenticationFailure(result: CliResult): boolean {
  return /(?:401|403|unauthorized|forbidden|authentication|password authentication failed)/i.test(
    `${result.stdout}\n${result.stderr}`,
  );
}

function isHistoryFailure(result: CliResult): boolean {
  return /(?:migration repair|migration history|remote migration versions|out of sync)/i.test(
    `${result.stdout}\n${result.stderr}`,
  );
}

function assertCliVersion(): void {
  const result = callCli(['--version']);
  if (result.status !== 0) {
    throw failure('configuration_missing', 'Pinned Supabase CLI is unavailable. Run the plugin setup helper.');
  }
  const match = result.stdout.match(/(\d+\.\d+\.\d+)/);
  if (!match || match[1] !== PINNED_CLI_VERSION) {
    throw failure('configuration_missing', `Supabase CLI ${PINNED_CLI_VERSION} is required.`);
  }
}

function readBinding(bindingPath: string): Binding | undefined {
  if (!existsSync(bindingPath)) return undefined;
  try {
    const value = JSON.parse(readFileSync(bindingPath, 'utf8')) as Partial<Binding>;
    if (
      value.schemaVersion !== '1.0' ||
      typeof value.heroesTenantKey !== 'string' ||
      typeof value.supabaseProjectRef !== 'string' ||
      typeof value.supabaseProjectName !== 'string' ||
      typeof value.supabaseRegion !== 'string'
    ) {
      throw new Error('invalid fields');
    }
    return value as Binding;
  } catch {
    throw failure('project_binding_ambiguous', 'Supabase binding is ambiguous or invalid. Inspect self/supabase/binding.json.');
  }
}

function selectProjectRef(
  tenantKey: string,
  requestedProjectRef: string | undefined,
  existing: Binding | undefined,
): string {
  if (existing && existing.heroesTenantKey !== tenantKey) {
    throw failure('project_identity_mismatch', 'Supabase binding tenant does not match the active Heroes tenant.');
  }
  if (existing && requestedProjectRef && existing.supabaseProjectRef !== requestedProjectRef) {
    throw failure('project_binding_ambiguous', 'Supabase project selection conflicts with the existing workspace binding.');
  }
  const projectRef = requestedProjectRef ?? existing?.supabaseProjectRef;
  if (!projectRef) throw failure('configuration_missing', 'Supabase project identity is missing. Pass --project-ref once.');
  if (!/^[a-z0-9]{20}$/.test(projectRef)) {
    throw failure('configuration_missing', 'Supabase project identity is invalid. Expected one 20-character project ref.');
  }
  return projectRef;
}

function listSelectedProject(projectRef: string): Omit<Binding, 'schemaVersion' | 'heroesTenantKey'> {
  const result = callCli(['projects', 'list', '--output', 'json']);
  if (result.status !== 0) {
    if (isAuthenticationFailure(result)) {
      throw failure('authentication_failed', 'Supabase authentication failed. Check the local access token.');
    }
    throw failure('project_unreachable', 'Supabase is unreachable. Check the network and try the preflight again.');
  }
  let projects: unknown;
  try {
    projects = JSON.parse(result.stdout);
  } catch {
    throw failure('project_unreachable', 'Supabase project preflight returned an invalid response.');
  }
  if (!Array.isArray(projects)) throw failure('project_unreachable', 'Supabase project preflight returned an invalid response.');
  const matches = projects.filter((project) =>
    project && typeof project === 'object' && (project as { id?: unknown }).id === projectRef,
  ) as { id: string; name?: unknown; region?: unknown }[];
  if (matches.length !== 1) {
    throw failure('project_identity_mismatch', 'Supabase project identity mismatch. The selected project is not uniquely accessible.');
  }
  const project = matches[0];
  return {
    supabaseProjectRef: projectRef,
    supabaseProjectName: typeof project.name === 'string' ? project.name : 'unnamed project',
    supabaseRegion: typeof project.region === 'string' ? project.region : 'unknown region',
  };
}

function writeBinding(bindingPath: string, binding: Binding): void {
  mkdirSync(dirname(bindingPath), { recursive: true });
  const next = `${bindingPath}.next`;
  writeFileSync(next, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 });
  renameSync(next, bindingPath);
  chmodSync(bindingPath, 0o600);
}

function refusePendingAttempt(attemptPath: string): void {
  if (!existsSync(attemptPath)) return;
  throw failure(
    'migration_partial',
    'A prior migration attempt did not verify. An operator must inspect project state before retry.',
  );
}

function writeAttempt(attemptPath: string, binding: Binding, migrations: string[]): void {
  writeFileSync(
    attemptPath,
    `${JSON.stringify({
      schemaVersion: '1.0',
      heroesTenantKey: binding.heroesTenantKey,
      supabaseProjectRef: binding.supabaseProjectRef,
      migrations,
      status: 'applying',
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function prepareProject(projectDir: string): string[] {
  const sourceSupabase = join(sourceProject, 'supabase');
  const targetSupabase = join(projectDir, 'supabase');
  if (!existsSync(targetSupabase)) {
    mkdirSync(projectDir, { recursive: true });
    cpSync(sourceSupabase, targetSupabase, { recursive: true, errorOnExist: true });
  }
  const migrationDir = join(sourceSupabase, 'migrations');
  const migrationFiles = readdirSync(migrationDir).filter((name) => /^\d+_.+\.sql$/.test(name));
  for (const name of ['config.toml', ...migrationFiles.map((file) => join('migrations', file))]) {
    const source = readFileSync(join(sourceSupabase, name), 'utf8');
    const target = join(targetSupabase, name);
    if (!existsSync(target) || readFileSync(target, 'utf8') !== source) {
      throw failure('migration_history_mismatch', `Local Supabase bootstrap file diverged: ${name}. Restore the plugin copy.`);
    }
  }
  return migrationFiles.map((name) => name.slice(0, name.indexOf('_'))).sort();
}

function workdirArgs(projectDir: string, args: string[]): string[] {
  return ['--workdir', projectDir, ...args];
}

function linkProject(projectDir: string, projectRef: string): void {
  const result = callCli(workdirArgs(projectDir, ['link', '--project-ref', projectRef, '--yes']));
  if (result.status === 0) return;
  if (isAuthenticationFailure(result)) {
    throw failure('authentication_failed', 'Supabase database authentication failed. Check the local database password.');
  }
  throw failure('project_unreachable', 'Supabase project connection failed. The selected project is unreachable.');
}

function migrationList(projectDir: string): unknown[] {
  const result = callCli(
    workdirArgs(projectDir, ['migration', 'list', '--linked', '--output', 'json']),
  );
  if (result.status !== 0) {
    if (isAuthenticationFailure(result)) {
      throw failure('authentication_failed', 'Supabase database authentication failed during migration verification.');
    }
    throw failure('migration_history_mismatch', 'Supabase migration history could not be read. Do not run migration repair automatically.');
  }
  try {
    const rows = JSON.parse(result.stdout);
    if (!Array.isArray(rows)) throw new Error('not an array');
    return rows;
  } catch {
    throw failure('migration_history_mismatch', 'Supabase migration history returned an invalid response.');
  }
}

function valueOf(row: unknown, key: 'local' | 'remote'): string | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const entry = Object.entries(row as Record<string, unknown>).find(
    ([name]) => name.toLowerCase() === key,
  );
  if (!entry || typeof entry[1] !== 'string') return undefined;
  const value = entry[1].replace(/`/g, '').trim();
  return value || undefined;
}

function assertHistoryMatches(rows: unknown[], expectedVersions: string[], phase: 'before' | 'after'): void {
  const local = new Set(rows.map((row) => valueOf(row, 'local')).filter((v): v is string => !!v));
  const remote = new Set(rows.map((row) => valueOf(row, 'remote')).filter((v): v is string => !!v));
  if (phase === 'before') {
    const unexpectedRemote = [...remote].filter((version) => !local.has(version));
    if (unexpectedRemote.length) {
      throw failure('migration_history_mismatch', 'Supabase migration history diverges from this workspace. An operator must reconcile it.');
    }
    return;
  }
  const missing = expectedVersions.filter((version) => !local.has(version) || !remote.has(version));
  const divergent = rows.some((row) => valueOf(row, 'local') !== valueOf(row, 'remote'));
  if (missing.length || divergent) {
    throw failure(
      'migration_partial',
      'Supabase migration history is partial or divergent. Inspect it before retry. Do not run migration repair automatically.',
    );
  }
}

function historyIsCurrent(rows: unknown[], expectedVersions: string[]): boolean {
  const local = new Set(rows.map((row) => valueOf(row, 'local')).filter((v): v is string => !!v));
  const remote = new Set(rows.map((row) => valueOf(row, 'remote')).filter((v): v is string => !!v));
  return (
    expectedVersions.every((version) => local.has(version) && remote.has(version)) &&
    rows.every((row) => valueOf(row, 'local') === valueOf(row, 'remote'))
  );
}

function pushMigrations(projectDir: string, dryRun: boolean): void {
  const args = workdirArgs(projectDir, [
    'db', 'push', '--linked', ...(dryRun ? ['--dry-run'] : []), '--yes',
  ]);
  const result = callCli(args);
  if (result.status === 0) return;
  if (isAuthenticationFailure(result)) {
    throw failure('authentication_failed', 'Supabase database authentication failed during migration.');
  }
  if (isHistoryFailure(result)) {
    throw failure('migration_history_mismatch', 'Supabase migration history diverges. An operator must reconcile it.');
  }
  throw failure(
    'migration_failed',
    'Supabase migration failed. Database state may be partial. Inspect migration history before retry.',
  );
}

run(async () => {
  const { flags } = parseArgs(process.argv.slice(2));
  const tenantKey = readTenantKey();
  requireCredentials();
  assertCliVersion();

  const bindingPath = join(process.cwd(), 'self', 'supabase', 'binding.json');
  const existing = readBinding(bindingPath);
  const projectRef = selectProjectRef(tenantKey, flagString(flags, 'project-ref'), existing);
  const project = listSelectedProject(projectRef);
  const binding: Binding = { schemaVersion: '1.0', heroesTenantKey: tenantKey, ...project };
  writeBinding(bindingPath, binding);

  const projectDir = join(process.cwd(), 'self', 'supabase', 'project');
  const migrationVersions = prepareProject(projectDir);
  const attemptPath = join(process.cwd(), 'self', 'supabase', 'migration-attempt.json');
  refusePendingAttempt(attemptPath);
  linkProject(projectDir, projectRef);
  const before = migrationList(projectDir);
  assertHistoryMatches(before, migrationVersions, 'before');
  const wasUpToDate = historyIsCurrent(before, migrationVersions);
  pushMigrations(projectDir, true);

  heading('Supabase bootstrap');
  kv('Heroes tenant', tenantKey);
  kv('Supabase project', project.supabaseProjectName);
  kv('region', project.supabaseRegion);
  kv('binding', bindingPath);

  if (flags['dry-run'] === true) {
    kv('status', 'valid; no migration applied');
    return;
  }

  writeAttempt(attemptPath, binding, migrationVersions);
  pushMigrations(projectDir, false);
  const after = migrationList(projectDir);
  assertHistoryMatches(after, migrationVersions, 'after');
  unlinkSync(attemptPath);
  kv(
    'status',
    wasUpToDate
      ? 'already up to date; no migration applied'
      : 'connected; migrations verified',
  );
});
