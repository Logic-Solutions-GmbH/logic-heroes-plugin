#!/usr/bin/env node
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
const hasGitRepository = existsSync(join(repoRoot, '.git'));

function walk(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    errors.push(`symlink is not portable: ${relative(repoRoot, path)}`);
  } else if (stat.isDirectory()) {
    if (basename(path) === 'node_modules') return;
    for (const entry of readdirSync(path)) walk(join(path, entry));
  } else files.push(path);
}
for (const output of outputs) walk(output);

for (const file of files) {
  const rel = relative(repoRoot, file);
  if (basename(file) === '.DS_Store') errors.push(`forbidden metadata: ${rel}`);
  if (basename(file) === '.env') errors.push(`filled environment file: ${rel}`);
  const text = readFileSync(file, 'utf8');
  if (/\/(?:Users|home)\/[A-Za-z0-9._ -]+\//.test(text) || /[A-Za-z]:\\Users\\/.test(text)) {
    errors.push(`local machine path: ${rel}`);
  }
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(text) ||
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(text) ||
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text) ||
    /\b(?:lh_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,})\b/.test(text)
  ) {
    errors.push(`token-like value: ${rel}`);
  }
  if (basename(file) === '.env.example') {
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      if (!/^[A-Z][A-Z0-9_]*=$/.test(line)) errors.push(`filled or invalid env example line in ${rel}`);
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
    if (entry.policy?.authentication !== 'ON_INSTALL') errors.push('wrong Codex authentication policy');
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

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`Portability validation passed (${files.length} owned output files scanned).`);
if (!hasGitRepository) {
  console.log('Tracked-file scan unavailable: no Git repository found; declared plugin and marketplace outputs were scanned directly.');
}
