import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_PATH = 'plugins/heroes-agent/skills/heroes-agent/scripts/heroes-tools';
const PACKAGE_PATH = `${TOOLS_PATH}/package.json`;
const SCRIPT_DIRECTORY = 'plugins/heroes-agent/scripts';

export type DatasetExtensionRule = 'production-typescript' | 'tracked-sql' | 'script';

export type DatasetExtensionEnvelope = {
  status: 'passed' | 'refused' | 'invalid';
  base: string;
  violations: Array<{ rule: DatasetExtensionRule; path: string }>;
};

export type DatasetExtensionResult = {
  exitCode: 0 | 2 | 4;
  envelope: DatasetExtensionEnvelope;
};

type Change = { status: string; paths: string[] };

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function parseChanges(output: string): Change[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const changes: Change[] = [];

  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const pathCount = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    changes.push({ status, paths: fields.slice(index, index + pathCount) });
    index += pathCount;
  }
  return changes;
}

function changedPaths(repository: string, base: string): string[] {
  const changes = parseChanges(git(repository, ['diff', '--name-status', '-z', base]));
  const tracked = changes.flatMap(({ paths }) => paths);
  const untracked = git(repository, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

function scriptsFromJson(source: string | undefined): Record<string, unknown> {
  if (source === undefined) return {};
  try {
    const parsed = JSON.parse(source) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) return {};
    return parsed.scripts as Record<string, unknown>;
  } catch {
    return {};
  }
}

function baseScripts(repository: string, base: string): Record<string, unknown> {
  try {
    return scriptsFromJson(git(repository, ['show', `${base}:${PACKAGE_PATH}`]));
  } catch {
    return {};
  }
}

function workingScripts(repository: string): Record<string, unknown> {
  const path = join(repository, PACKAGE_PATH);
  return scriptsFromJson(existsSync(path) ? readFileSync(path, 'utf8') : undefined);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function scriptEntryViolations(repository: string, base: string): Array<{ rule: 'script'; path: string }> {
  const before = baseScripts(repository, base);
  const after = workingScripts(repository);
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

  return names.flatMap((name) => {
    if (sameValue(before[name], after[name])) return [];
    const isAllowedNewTest = !(name in before) && name.startsWith('test:');
    return isAllowedNewTest ? [] : [{ rule: 'script' as const, path: `${PACKAGE_PATH}#scripts.${name}` }];
  });
}

function pathViolations(paths: string[]): Array<{ rule: DatasetExtensionRule; path: string }> {
  const violations: Array<{ rule: DatasetExtensionRule; path: string }> = [];
  const productionPattern = new RegExp(`^${TOOLS_PATH.replaceAll('/', '\\/')}\/[^/]+\\.ts$`);
  const directScriptPattern = new RegExp(`^${SCRIPT_DIRECTORY.replaceAll('/', '\\/')}\/[^/]+$`);

  for (const path of paths) {
    if (productionPattern.test(path)) violations.push({ rule: 'production-typescript', path });
    if (path.endsWith('.sql')) violations.push({ rule: 'tracked-sql', path });
    if (directScriptPattern.test(path)) violations.push({ rule: 'script', path });
  }
  return violations;
}

export function proveDatasetExtension(options: { repository?: string; base?: string } = {}): DatasetExtensionResult {
  const startDirectory = resolve(options.repository ?? process.cwd());
  const baseReference = options.base ?? 'origin/main';
  let repository: string;
  let base: string;

  try {
    repository = git(startDirectory, ['rev-parse', '--show-toplevel']).trim();
    base = git(repository, ['merge-base', 'HEAD', baseReference]).trim();
    if (!base) throw new Error('empty merge base');
  } catch {
    return {
      exitCode: 2,
      envelope: { status: 'invalid', base: baseReference, violations: [] },
    };
  }

  const paths = changedPaths(repository, base);
  const violations = pathViolations(paths);
  if (paths.includes(PACKAGE_PATH)) violations.push(...scriptEntryViolations(repository, base));
  violations.sort((left, right) => left.path.localeCompare(right.path) || left.rule.localeCompare(right.rule));

  return {
    exitCode: violations.length === 0 ? 0 : 4,
    envelope: {
      status: violations.length === 0 ? 'passed' : 'refused',
      base,
      violations,
    },
  };
}

function cliBase(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === '--base' && args[1]) return args[1];
  throw new Error('usage: dataset-extension-proof.ts [--base <ref>]');
}

function isProcessEntry(): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isProcessEntry()) {
  let result: DatasetExtensionResult;
  try {
    result = proveDatasetExtension({ base: cliBase(process.argv.slice(2)) });
  } catch {
    result = {
      exitCode: 2,
      envelope: { status: 'invalid', base: 'origin/main', violations: [] },
    };
  }
  console.log(JSON.stringify(result.envelope, null, 2));
  process.exitCode = result.exitCode;
}
