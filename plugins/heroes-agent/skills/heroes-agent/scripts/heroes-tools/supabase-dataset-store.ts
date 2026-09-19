import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const MANAGEMENT_URL = 'https://api.supabase.com';
const PINNED_CLI_VERSION = '2.117.0';

export interface SupabaseQueryRequest {
  action: 'project' | 'query-read-only' | 'query-write';
  projectRef: string;
  query?: string;
}

export interface SupabaseMigrationFile {
  file: string;
  source: string;
  version: string;
}

export interface MigrationHistoryRow {
  local?: string;
  remote?: string;
}

export interface RequiredMigration {
  version: string;
  missingDependencyMessage?: string;
}

export function failure(code: string, message: string): Error {
  return new Error(`[${code}] ${message}`);
}

function managementEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'COMSPEC', 'PATHEXT',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    'FAKE_QUERY_LOG', 'FAKE_SUPABASE_STATE',
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  environment.SUPABASE_ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
  return environment;
}

function cliPath(toolsDir: string): string {
  return process.env.HEROES_SUPABASE_CLI ?? join(toolsDir, 'node_modules', 'supabase', 'dist', 'supabase.js');
}

function cliEnvironment(): NodeJS.ProcessEnv {
  const environment = managementEnvironment();
  environment.SUPABASE_DB_PASSWORD = process.env.SUPABASE_DB_PASSWORD;
  environment.FAKE_SUPABASE_LOG = process.env.FAKE_SUPABASE_LOG;
  return environment;
}

export function callCli(
  toolsDir: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath(toolsDir), ...args], {
    cwd: process.cwd(),
    env: cliEnvironment(),
    encoding: 'utf8',
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

export function requireCli(toolsDir: string): void {
  if (!process.env.SUPABASE_DB_PASSWORD) {
    throw failure('configuration_missing', 'Supabase database password is missing.');
  }
  const result = callCli(toolsDir, ['--version']);
  if (result.status !== 0 || result.stdout.trim() !== PINNED_CLI_VERSION) {
    throw failure('configuration_missing', `Supabase CLI ${PINNED_CLI_VERSION} is required.`);
  }
}

export function copyExact(source: string, target: string): void {
  if (existsSync(target)) {
    if (readFileSync(target, 'utf8') !== readFileSync(source, 'utf8')) {
      throw failure('migration_history_mismatch', `Local Supabase migration diverged: ${target}.`);
    }
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

export function prepareMigrations(options: {
  workspace: string;
  bootstrapProject: string;
  migrations: SupabaseMigrationFile[];
}): string {
  const projectDir = join(options.workspace, 'self', 'supabase', 'project');
  copyExact(
    join(options.bootstrapProject, 'config.toml'),
    join(projectDir, 'supabase', 'config.toml'),
  );
  copyExact(
    join(options.bootstrapProject, 'migrations', '20260908000100_heroes_agent_bootstrap.sql'),
    join(projectDir, 'supabase', 'migrations', '20260908000100_heroes_agent_bootstrap.sql'),
  );
  for (const migration of options.migrations) {
    copyExact(migration.source, join(projectDir, 'supabase', 'migrations', migration.file));
  }
  return projectDir;
}

export function migrationRows(
  toolsDir: string,
  projectDir: string,
  projectRef: string,
): MigrationHistoryRow[] {
  const result = callCli(toolsDir, [
    '--workdir', projectDir, '--output-format', 'json',
    'migration', 'list', '--project-ref', projectRef,
  ]);
  if (result.status !== 0) {
    throw failure('migration_history_mismatch', 'Supabase migration history could not be read.');
  }
  try {
    const value = JSON.parse(result.stdout) as { migrations?: MigrationHistoryRow[] };
    if (!Array.isArray(value.migrations)) throw new Error('invalid migrations');
    return value.migrations;
  } catch {
    throw failure('migration_history_mismatch', 'Supabase migration history returned invalid JSON.');
  }
}

function migrationValue(value: string | undefined): string | undefined {
  const normalized = value?.replace(/`/g, '').trim();
  return normalized || undefined;
}

export function assertMigrationHistory(options: {
  rows: MigrationHistoryRow[];
  requiredMigrations: RequiredMigration[];
  requireAll: boolean;
  missingRequiredMessage: string;
}): boolean {
  for (const row of options.rows) {
    const local = migrationValue(row.local);
    const remote = migrationValue(row.remote);
    if (remote && !local) {
      throw failure('migration_history_mismatch', 'Remote migration history is not present locally.');
    }
    if (local && remote && local !== remote) {
      throw failure('migration_history_mismatch', 'Migration history is divergent.');
    }
  }
  const hasBootstrap = options.rows.some((row) => (
    migrationValue(row.local) === '20260908000100'
    && migrationValue(row.remote) === '20260908000100'
  ));
  if (!hasBootstrap) {
    throw failure('migration_history_mismatch', 'The verified S3 bootstrap migration is missing.');
  }
  const applied = options.requiredMigrations.map(({ version }) => options.rows.some((row) => (
    migrationValue(row.local) === version && migrationValue(row.remote) === version
  )));
  for (let index = 1; index < options.requiredMigrations.length; index++) {
    if (applied[index] && !applied[index - 1]) {
      throw failure(
        'migration_partial',
        options.requiredMigrations[index].missingDependencyMessage
          ?? 'A later migration lacks its required earlier migration.',
      );
    }
  }
  if (options.requireAll && applied.some((value) => !value)) {
    throw failure('migration_partial', options.missingRequiredMessage);
  }
  return applied.every(Boolean);
}

export function dryRunPush(toolsDir: string, projectDir: string, projectRef: string): void {
  const result = callCli(toolsDir, [
    '--workdir', projectDir, 'db', 'push', '--project-ref', projectRef, '--dry-run', '--yes',
  ]);
  if (result.status !== 0) throw failure('migration_failed', 'Supabase migration dry run failed.');
}

export function applyPush(toolsDir: string, projectDir: string, projectRef: string): void {
  const result = callCli(toolsDir, [
    '--workdir', projectDir, 'db', 'push', '--project-ref', projectRef, '--yes',
  ]);
  if (result.status !== 0) {
    throw failure('migration_failed', 'Supabase migration failed. Inspect live state before retry.');
  }
}

export function writeAttempt(path: string, value: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function objectResult(value: unknown, field: string): Record<string, unknown> {
  if (!Array.isArray(value) || !value[0] || typeof value[0] !== 'object') {
    throw failure('verification_failed', `Supabase ${field} result is invalid.`);
  }
  const result = (value[0] as Record<string, unknown>)[field];
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw failure('verification_failed', `Supabase ${field} result is invalid.`);
  }
  return result as Record<string, unknown>;
}

export async function managementRequest(request: SupabaseQueryRequest): Promise<unknown> {
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (!accessToken) throw failure('configuration_missing', 'Supabase access token is missing.');
  const runner = process.env.HEROES_SUPABASE_QUERY_RUNNER;
  if (runner) {
    const result = spawnSync(process.execPath, [runner], {
      input: JSON.stringify(request),
      encoding: 'utf8',
      env: managementEnvironment(),
    });
    if (result.status !== 0) throw failure('project_unreachable', 'Supabase metadata query failed.');
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw failure('project_unreachable', 'Supabase metadata query returned invalid JSON.');
    }
  }

  const readOnly = request.action === 'query-read-only';
  const endpoint = request.action === 'project'
    ? `/v1/projects/${request.projectRef}`
    : `/v1/projects/${request.projectRef}/database/query${readOnly ? '/read-only' : ''}`;
  const response = await fetch(`${MANAGEMENT_URL}${endpoint}`, {
    method: request.action === 'project' ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(request.action === 'project' ? {} : { 'content-type': 'application/json' }),
    },
    ...(request.action === 'project' ? {} : { body: JSON.stringify({ query: request.query }) }),
  });
  const responseText = await response.text();
  if (!response.ok) {
    let detail = '';
    try {
      const body = JSON.parse(responseText) as Record<string, unknown>;
      const candidate = [body.message, body.error, body.hint, body.details]
        .find((value) => typeof value === 'string' && value.trim());
      if (typeof candidate === 'string') detail = ` ${candidate.slice(0, 500)}`;
    } catch {
      // Keep non-JSON upstream bodies private.
    }
    for (const secret of [process.env.SUPABASE_ACCESS_TOKEN, process.env.SUPABASE_DB_PASSWORD]) {
      if (secret) detail = detail.split(secret).join('[redacted]');
    }
    throw failure(
      'project_unreachable',
      `Supabase metadata query failed with status ${response.status}.${detail}`,
    );
  }
  try {
    return JSON.parse(responseText);
  } catch {
    throw failure('project_unreachable', 'Supabase metadata query returned invalid JSON.');
  }
}
