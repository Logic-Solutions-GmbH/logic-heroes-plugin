/**
 * transport-order-contract — paths and optional validation for ServiceRequest v3.
 *
 * Read-only. Does not call Heroes or Logic TMS. Use when the human asked for
 * Logic TMS / transportOrder XML generation.
 *
 * Usage:
 *   npx tsx transport-order-contract.ts [--json]
 *   npx tsx transport-order-contract.ts --validate <file.xml>
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, flagString } from './lib';

export interface TransportOrderContractPaths {
  guidePath: string;
  xsdPath: string;
  examplePath: string;
  logicCoreDocsNote: string;
  snapshotDate: string;
}

export function pluginRootFromToolsDir(toolsDir: string): string {
  return resolve(toolsDir, '..', '..', '..', '..');
}

export function resolveTransportOrderContractPaths(
  toolsDir = dirname(fileURLToPath(import.meta.url)),
): TransportOrderContractPaths {
  const pluginRoot = pluginRootFromToolsDir(toolsDir);
  const refRoot = join(pluginRoot, 'skills', 'heroes-agent', 'references');
  return {
    guidePath: join(refRoot, 'transport-order.md'),
    xsdPath: join(refRoot, 'service-request-v3', 'ServiceRequest.v3.xsd'),
    examplePath: join(refRoot, 'service-request-v3', 'ServiceRequest.v3.full-example.xml'),
    logicCoreDocsNote:
      'logic-core/docs/service-request-v3/ (example captures; refresh this plugin snapshot when TransportOrderXmlBuilderService changes)',
    snapshotDate: '2026-10-21',
  };
}

function assertContractFiles(paths: TransportOrderContractPaths): void {
  for (const [label, path] of [
    ['guide', paths.guidePath],
    ['xsd', paths.xsdPath],
    ['example', paths.examplePath],
  ] as const) {
    if (!existsSync(path)) {
      throw new Error(`missing transport-order contract file (${label}): ${path}`);
    }
  }
}

function validateWithXmllint(xsdPath: string, xmlPath: string): void {
  if (!existsSync(xmlPath)) {
    throw new Error(`XML file not found: ${xmlPath}`);
  }
  let result;
  try {
    result = spawnSync(
      'xmllint',
      ['--noout', '--schema', xsdPath, xmlPath],
      { encoding: 'utf8' },
    );
  } catch {
    throw new Error('xmllint is not available on this host; install libxml2 to use --validate');
  }
  if (result.error) {
    throw new Error(`xmllint failed to run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(detail || 'XML does not validate against ServiceRequest.v3.xsd');
  }
  console.log(`${xmlPath} validates against ServiceRequest.v3.xsd`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const validatePath = flagString(flags, 'validate');
  const asJson = flags.json === true || (!validatePath && !('json' in flags) && process.stdout.isTTY === false);

  const paths = resolveTransportOrderContractPaths();
  assertContractFiles(paths);

  if (validatePath) {
    validateWithXmllint(paths.xsdPath, validatePath);
    return;
  }

  const payload = {
    ...paths,
    validateExampleCommand: `xmllint --noout --schema "${paths.xsdPath}" "${paths.examplePath}"`,
  };

  if (asJson || flags.json === true) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('ServiceRequest v3 contract (Logic TMS transport order, opt-in)');
  console.log(`  snapshotDate     ${paths.snapshotDate}`);
  console.log(`  guide            ${paths.guidePath}`);
  console.log(`  xsd              ${paths.xsdPath}`);
  console.log(`  example          ${paths.examplePath}`);
  console.log(`  logicCoreDocs    ${paths.logicCoreDocsNote}`);
}

main().catch((err) => {
  console.error(`\n✖ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
