/**
 * list-heroes-tools — catalog bundled heroes-tools scripts for agents.
 *
 * Usage:
 *   npx tsx list-heroes-tools.ts [--json]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib';

const toolsDir = dirname(fileURLToPath(import.meta.url));

function summaryFromSource(source: string, fileName: string): string {
  const block = source.match(/^\/\*\*([\s\S]*?)\*\//);
  if (!block) return fileName;
  const lines = block[1]
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean);
  const dashLine = lines.find((line) => line.startsWith('—') || line.startsWith('-'));
  if (dashLine) return dashLine.replace(/^—\s*/, '').replace(/^-\s*/, '');
  return lines[0] ?? fileName;
}

function listTools(): { name: string; summary: string }[] {
  return readdirSync(toolsDir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .filter((name) => name !== 'lib.ts')
    .sort()
    .map((name) => {
      const source = readFileSync(join(toolsDir, name), 'utf8');
      return { name, summary: summaryFromSource(source, name) };
    });
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const tools = listTools();
  if (flags.json === true) {
    console.log(JSON.stringify({ tools }, null, 2));
    return;
  }
  console.log('Heroes agent tools (run via scripts/run-tool.mjs <name>)');
  for (const tool of tools) {
    console.log(`  ${tool.name.padEnd(28)} ${tool.summary}`);
  }
}

main().catch((err) => {
  console.error(`\n✖ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
