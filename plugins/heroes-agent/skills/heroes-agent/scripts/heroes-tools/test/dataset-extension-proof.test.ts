import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryToolsPath = 'plugins/heroes-agent/skills/heroes-agent/scripts/heroes-tools';
const gatePath = join(toolsDir, 'test', 'dataset-extension-proof.ts');
const tsxCliPath = join(toolsDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const packagePath = `${repositoryToolsPath}/package.json`;
const existingProductionPath = `${repositoryToolsPath}/dataset.ts`;
const existingSqlPath = 'assets/existing.sql';

type GateEnvelope = {
  status: 'passed' | 'refused' | 'invalid';
  base: string;
  violations: Array<{ rule: 'production-typescript' | 'tracked-sql' | 'script'; path: string }>;
};

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(repository: string, path: string, content: string): void {
  const target = join(repository, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function initialise(repository: string, branch = 'main'): void {
  git(repository, 'init', '-b', branch);
  git(repository, 'config', 'user.name', 'Dataset proof');
  git(repository, 'config', 'user.email', 'dataset-proof@example.invalid');
  write(repository, existingProductionPath, 'export const dataset = true;\n');
  write(repository, existingSqlPath, 'select 1;\n');
  write(repository, 'plugins/heroes-agent/scripts/existing.mjs', 'export {};\n');
  write(repository, packagePath, `${JSON.stringify({ scripts: {
    test: 'node --test',
    'test:existing': 'node --test test/existing.test.ts',
  } }, null, 2)}\n`);
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'baseline');
  if (branch === 'main') git(repository, 'switch', '-c', 'dataset-change');
}

function commit(repository: string, message: string): void {
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', message);
}

function runGate(repository: string, base = 'main') {
  const result = spawnSync(process.execPath, [tsxCliPath, gatePath, '--base', base], {
    cwd: join(repository, repositoryToolsPath),
    encoding: 'utf8',
  });
  assert.equal(result.signal, null, result.stderr);
  return {
    exitCode: result.status,
    envelope: JSON.parse(result.stdout) as GateEnvelope,
    stderr: result.stderr,
  };
}

function withRepository(run: (repository: string) => void, branch = 'main'): void {
  const repository = mkdtempSync(join(tmpdir(), 'heroes-dataset-extension-proof-'));
  try {
    initialise(repository, branch);
    run(repository);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}

function assertPassed(result: ReturnType<typeof runGate>): void {
  assert.equal(result.exitCode, 0, result.stderr || JSON.stringify(result.envelope));
  assert.equal(result.envelope.status, 'passed');
  assert.deepEqual(result.envelope.violations, []);
}

function assertRefused(
  result: ReturnType<typeof runGate>,
  rule: GateEnvelope['violations'][number]['rule'],
  path: string,
): void {
  assert.equal(result.exitCode, 4, result.stderr || JSON.stringify(result.envelope));
  assert.equal(result.envelope.status, 'refused');
  assert.deepEqual(result.envelope.violations, [{ rule, path }]);
}

test('dataset extension gate passes data-only changes and refuses every extension rule', () => {
  withRepository((repository) => {
    write(repository, `${repositoryToolsPath}/test/fixtures/second-domain/manifest.json`, '{}\n');
    write(repository, `${repositoryToolsPath}/test/fixtures/second-domain/rows.csv`, 'id\n1\n');
    commit(repository, 'add data-only fixture');
    assertPassed(runGate(repository));

    const imported = spawnSync(process.execPath, [
      tsxCliPath,
      '--eval',
      `import(${JSON.stringify(pathToFileURL(gatePath).href)})`,
    ], {
      cwd: repository,
      encoding: 'utf8',
    });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, '');
  });

  withRepository((repository) => {
    const testPath = `${repositoryToolsPath}/test/second-domain.test.ts`;
    write(repository, testPath, 'export {};\n');
    write(repository, packagePath, `${JSON.stringify({ scripts: {
      test: 'node --test',
      'test:existing': 'node --test test/existing.test.ts',
      'test:dataset-second-domain': 'node --test test/second-domain.test.ts',
    } }, null, 2)}\n`);
    commit(repository, 'add dataset test');
    assertPassed(runGate(repository));
  });

  const plantedCases: Array<{
    name: string;
    rule: GateEnvelope['violations'][number]['rule'];
    path: string;
    plant: (repository: string) => void;
  }> = [
    {
      name: 'new production TypeScript',
      rule: 'production-typescript',
      path: `${repositoryToolsPath}/second-domain.ts`,
      plant: (repository) => write(repository, `${repositoryToolsPath}/second-domain.ts`, 'export {};\n'),
    },
    {
      name: 'changed production TypeScript',
      rule: 'production-typescript',
      path: existingProductionPath,
      plant: (repository) => write(repository, existingProductionPath, 'export const dataset = false;\n'),
    },
    {
      name: 'new tracked SQL',
      rule: 'tracked-sql',
      path: 'assets/second-domain.sql',
      plant: (repository) => write(repository, 'assets/second-domain.sql', 'select 2;\n'),
    },
    {
      name: 'changed tracked SQL',
      rule: 'tracked-sql',
      path: existingSqlPath,
      plant: (repository) => write(repository, existingSqlPath, 'select 2;\n'),
    },
    {
      name: 'new plugin script',
      rule: 'script',
      path: 'plugins/heroes-agent/scripts/second-domain.mjs',
      plant: (repository) => write(repository, 'plugins/heroes-agent/scripts/second-domain.mjs', 'export {};\n'),
    },
    {
      name: 'nested plugin script',
      rule: 'script',
      path: 'plugins/heroes-agent/scripts/nested/escape.mjs',
      plant: (repository) => write(repository, 'plugins/heroes-agent/scripts/nested/escape.mjs', 'export {};\n'),
    },
    {
      name: 'new non-test package script',
      rule: 'script',
      path: `${packagePath}#scripts.prove:second-domain`,
      plant: (repository) => write(repository, packagePath, `${JSON.stringify({ scripts: {
        test: 'node --test',
        'test:existing': 'node --test test/existing.test.ts',
        'prove:second-domain': 'node test/second-domain.ts',
      } }, null, 2)}\n`),
    },
  ];

  for (const planted of plantedCases) {
    withRepository((repository) => {
      planted.plant(repository);
      commit(repository, `plant ${planted.name}`);
      assertRefused(runGate(repository), planted.rule, planted.path);
    });
  }

  withRepository((repository) => {
    const plantedPath = `${repositoryToolsPath}/first-commit.ts`;
    write(repository, plantedPath, 'export {};\n');
    commit(repository, 'plant violation');
    write(repository, `${repositoryToolsPath}/test/fixtures/second-domain/manifest.json`, '{}\n');
    commit(repository, 'add manifest');
    assertRefused(runGate(repository), 'production-typescript', plantedPath);
  });

  withRepository((repository) => {
    const plantedPath = `${repositoryToolsPath}/untracked.ts`;
    write(repository, plantedPath, 'export {};\n');
    assertRefused(runGate(repository), 'production-typescript', plantedPath);
  });

  withRepository((repository) => {
    write(repository, existingProductionPath, 'export const dataset = false;\n');
    git(repository, 'add', existingProductionPath);
    write(repository, existingProductionPath, 'export const dataset = true;\n');
    assert.equal(git(repository, 'diff', '--cached', '--name-only'), existingProductionPath);
    assert.equal(git(repository, 'diff', '--name-only'), existingProductionPath);
    assertRefused(runGate(repository), 'production-typescript', existingProductionPath);
  });

  withRepository((repository) => {
    write(repository, packagePath, `${JSON.stringify({ scripts: {
      test: 'node --test',
      'test:existing': 'node --test test/existing.test.ts',
      'prove:masked': 'node test/masked.ts',
    } }, null, 2)}\n`);
    git(repository, 'add', packagePath);
    write(repository, packagePath, `${JSON.stringify({ scripts: {
      test: 'node --test',
      'test:existing': 'node --test test/existing.test.ts',
    } }, null, 2)}\n`);
    assertRefused(runGate(repository), 'script', `${packagePath}#scripts.prove:masked`);
  });

  withRepository((repository) => {
    write(repository, packagePath, `${JSON.stringify({ scripts: {
      test: 'node --test',
      'test:existing': 'node --test test/existing.test.ts',
      'test:second-domain': 'node --test test/second-domain-head.test.ts',
    } }, null, 2)}\n`);
    commit(repository, 'add second domain test script');
    write(repository, packagePath, `${JSON.stringify({ scripts: {
      test: 'node --test',
      'test:existing': 'node --test test/existing.test.ts',
      'test:second-domain': 'node --test test/second-domain-index.test.ts',
    } }, null, 2)}\n`);
    git(repository, 'add', packagePath);
    write(repository, packagePath, `${JSON.stringify({ scripts: {
      test: 'node --test',
      'test:existing': 'node --test test/existing.test.ts',
      'test:second-domain': 'node --test test/second-domain-working.test.ts',
    } }, null, 2)}\n`);
    assertPassed(runGate(repository));
  });

  withRepository((repository) => {
    const result = runGate(repository);
    assert.equal(result.exitCode, 2, result.stderr || JSON.stringify(result.envelope));
    assert.equal(result.envelope.status, 'invalid');
    assert.equal(result.envelope.base, 'main');
    assert.deepEqual(result.envelope.violations, []);
  }, 'dataset-change');
});
