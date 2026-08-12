#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pluginRoot, '..', '..');
const outputs = [
  pluginRoot,
  join(repoRoot, '.agents', 'plugins', 'marketplace.json'),
  join(repoRoot, '.claude-plugin', 'marketplace.json'),
  join(repoRoot, '.cursor-plugin', 'marketplace.json'),
];
const errors = [];
const files = [];
let hasGitRepository = false;
let headCommit;
let scanMode = 'declared outputs';

try {
  const gitRoot = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  hasGitRepository = resolve(gitRoot) === repoRoot;
} catch {
  // Git is optional for installed plugin copies. The fallback is intentionally narrower.
}

function walk(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    errors.push(`symlink is not portable: ${relative(repoRoot, path)}`);
  } else if (stat.isDirectory()) {
    if (basename(path) === 'node_modules') return;
    for (const entry of readdirSync(path)) walk(join(path, entry));
  } else files.push(path);
}
if (hasGitRepository) {
  headCommit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const status = execFileSync(
    'git',
    ['-C', repoRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { encoding: 'utf8' },
  );
  if (status.length) errors.push('release-state: working tree is not clean');

  const trackedPaths = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const stagedEntries = execFileSync('git', ['-C', repoRoot, 'ls-files', '--stage', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  for (const entry of stagedEntries) {
    const tab = entry.indexOf('\t');
    const metadata = tab === -1 ? entry : entry.slice(0, tab);
    const path = tab === -1 ? entry : entry.slice(tab + 1);
    if (metadata.startsWith('120000 ')) errors.push(`tracked-symlink: ${path}`);
  }
  for (const path of trackedPaths) {
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
      errors.push(`unsafe-tracked-path: ${path}`);
      continue;
    }
    files.push(resolve(repoRoot, path));
  }
  scanMode = 'tracked files';
} else {
  if (!existsSync(pluginRoot)) errors.push('missing-required-output: plugins/heroes-agent');
  for (const output of outputs) {
    if (existsSync(output)) walk(output);
  }
}

const secretRules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['api-token', /\b(?:lh_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,})\b/],
  [
    'signed-url-or-query-credential',
    /[?&](?:X-Amz-(?:Algorithm|Credential|Signature)|X-Goog-(?:Algorithm|Credential|Signature)|Signature|sig|token|access_token)=/i,
  ],
];
const uncPrefix = '\\\\' + '\\\\';
const localPathRules = [
  /\/(?:Users|home)\/[A-Za-z0-9._ -]+(?=\/|[\s'"`)]|$)/,
  /[A-Za-z]:[\\/]Users[\\/][^\\/\s'"`]+/,
  new RegExp(`${uncPrefix}[A-Za-z0-9._$-]+\\\\[A-Za-z0-9._$ -]+`),
  /\/(?:private\/)?var\/folders\/[A-Za-z0-9._/-]+/,
  /\/mnt\/[a-zA-Z]\/Users\/[A-Za-z0-9._ -]+(?=\/|[\s'"`)]|$)/,
];
const forbiddenMetadata = /(^|\/)(?:\.DS_Store|Thumbs\.db|__MACOSX|\._[^/]+|[^/]+\.(?:swp|swo|swn)|\.#[^/]+|[^/]+~)(?:\/|$)/i;

function decodeText(bytes, rel) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    if ((bytes.length - 2) % 2 !== 0) {
      errors.push(`invalid-utf16: ${rel}`);
      return null;
    }
    return bytes.subarray(2).toString('utf16le');
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const content = Buffer.from(bytes.subarray(2));
    if (content.length % 2 !== 0) {
      errors.push(`invalid-utf16: ${rel}`);
      return null;
    }
    content.swap16();
    return content.toString('utf16le');
  }
  if (bytes.includes(0)) return null;
  return bytes.toString('utf8');
}

for (const file of files) {
  const rel = relative(repoRoot, file);
  if (forbiddenMetadata.test(rel)) errors.push(`forbidden-metadata: ${rel}`);
  const name = basename(file);
  if (name.startsWith('.env') && name !== '.env.example') errors.push(`environment-file: ${rel}`);
  const bytes = readFileSync(file);
  const text = decodeText(bytes, rel);
  if (text === null) continue;
  for (const [category, pattern] of secretRules) {
    if (pattern.test(text)) errors.push(`${category}: ${rel}`);
  }
  if (localPathRules.some((pattern) => pattern.test(text))) errors.push(`machine-local-path: ${rel}`);
  if (basename(file) === '.env.example') {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      if (!/^[A-Z][A-Z0-9_]*=$/.test(line)) {
        errors.push(`nonblank-or-invalid-env-example: ${rel}`);
        break;
      }
    }
  }
}

const publicRepository = 'https://github.com/Logic-Solutions-GmbH/logic-heroes-plugin';
const publisherName = 'Logic Solutions GmbH';
for (const manifest of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.cursor-plugin/plugin.json']) {
  const path = join(pluginRoot, manifest);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  if (json.name !== 'heroes-agent') errors.push(`wrong manifest name: ${manifest}`);
  if (json.author?.name !== publisherName) errors.push(`wrong publisher name: ${manifest}`);
  if (json.homepage !== publicRepository) errors.push(`wrong homepage: ${manifest}`);
  if (json.repository !== publicRepository) errors.push(`wrong repository: ${manifest}`);
  if (json.license !== 'Apache-2.0') errors.push(`wrong license: ${manifest}`);
}

const catalogs = [
  {
    file: '.agents/plugins/marketplace.json',
    source: (entry) => entry.source?.path,
    expectedSource: './plugins/heroes-agent',
  },
  {
    file: '.claude-plugin/marketplace.json',
    source: (entry) => entry.source,
    expectedSource: './plugins/heroes-agent',
  },
  {
    file: '.cursor-plugin/marketplace.json',
    source: (entry) => entry.source,
    expectedSource: 'plugins/heroes-agent',
  },
];
for (const catalog of catalogs) {
  const path = join(repoRoot, catalog.file);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  if (json.name !== 'logic-heroes') errors.push(`wrong catalog name: ${catalog.file}`);
  if (!Array.isArray(json.plugins)) {
    errors.push(`plugins must be an array: ${catalog.file}`);
    continue;
  }
  if (catalog.file === '.agents/plugins/marketplace.json' && json.interface?.displayName !== 'Heroes Agent') {
    errors.push('wrong Codex catalog display name');
  }
  if (
    ['.claude-plugin/marketplace.json', '.cursor-plugin/marketplace.json'].includes(catalog.file) &&
    json.owner?.name !== publisherName
  ) {
    errors.push(`wrong catalog owner: ${catalog.file}`);
  }
  const entries = json.plugins.filter((entry) => entry.name === 'heroes-agent');
  if (entries.length !== 1) {
    errors.push(`catalog must contain one heroes-agent entry: ${catalog.file}`);
    continue;
  }
  const entry = entries[0];
  if (catalog.file === '.agents/plugins/marketplace.json') {
    if (entry.source?.source !== 'local') errors.push('wrong Codex source type');
    if (entry.policy?.installation !== 'AVAILABLE') errors.push('wrong Codex installation policy');
    if (entry.policy?.authentication !== 'ON_USE') errors.push('wrong Codex authentication policy');
    if (entry.category !== 'Productivity') errors.push('wrong Codex category');
  }
  const source = catalog.source(entry);
  if (source !== catalog.expectedSource) errors.push(`wrong plugin source in ${catalog.file}: ${source}`);
  if (typeof source !== 'string' || isAbsolute(source) || source.split(/[\\/]/).includes('..')) {
    errors.push(`unsafe plugin source in ${catalog.file}: ${source}`);
    continue;
  }
  const resolvedSource = resolve(repoRoot, source);
  const withinRepo = resolvedSource === repoRoot || resolvedSource.startsWith(`${repoRoot}${sep}`);
  if (!withinRepo || resolvedSource !== pluginRoot) errors.push(`plugin source does not resolve to shared root: ${catalog.file}`);
}

const codexManifest = JSON.parse(readFileSync(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
for (const asset of ['./assets/icon.png', './assets/logo.png']) {
  if (!existsSync(resolve(pluginRoot, asset))) errors.push(`missing Codex brand asset: ${asset}`);
}
if (codexManifest.interface?.composerIcon !== './assets/icon.png') errors.push('wrong Codex composer icon');
if (codexManifest.interface?.logo !== './assets/logo.png') errors.push('wrong Codex logo');
const cursorManifest = JSON.parse(readFileSync(join(pluginRoot, '.cursor-plugin', 'plugin.json'), 'utf8'));
if (cursorManifest.logo !== 'assets/logo.png') errors.push('wrong Cursor logo');
const skill = readFileSync(join(pluginRoot, 'skills', 'heroes-agent', 'SKILL.md'), 'utf8');
for (const assumption of ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_SKILL_DIR', 'CODEX_HOME']) {
  if (skill.includes(assumption)) errors.push(`platform-only assumption in shared skill: ${assumption}`);
}
if (!skill.startsWith('---\nname: heroes-agent\ndescription:')) errors.push('shared skill frontmatter is not portable');
if (
  !skill.includes(
    'Copy both JSON string values character-for-character into the initializer arguments.',
  )
) {
  errors.push('shared skill does not preserve structured identity values');
}
if (
  !skill.includes(
    'Compare its tenant key and display name with both JSON string values character-for-character. If either differs, report initialization failure and do not continue.',
  )
) {
  errors.push('shared skill does not verify initialized identity');
}
if (
  !skill.includes(
    'In the first new session that uses this installed plugin, before any HANDSHAKE, RFQ, or authenticated Heroes tool call:',
  )
) {
  errors.push('shared skill does not require onboarding in the first new plugin session');
}

if (errors.length) {
  if (headCommit) console.log(`HEAD commit: ${headCommit}`);
  console.log(`Scan scope: ${files.length} ${scanMode}.`);
  console.error(errors.join('\n'));
  process.exit(1);
}
if (headCommit) console.log(`HEAD commit: ${headCommit}`);
console.log(`Portability validation passed (${files.length} ${scanMode} scanned).`);
if (!hasGitRepository)
  console.log('Reduced coverage: Git is unavailable; only declared plugin and marketplace outputs were scanned.');
