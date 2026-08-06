#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
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

for (const manifest of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.cursor-plugin/plugin.json']) {
  const path = join(pluginRoot, manifest);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  if (json.name !== 'heroes-agent') errors.push(`wrong manifest name: ${manifest}`);
}
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
