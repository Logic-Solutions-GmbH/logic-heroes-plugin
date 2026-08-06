#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOSTED_API_URL = 'https://api.logicheroes.network/api';

const args = process.argv.slice(2);
const destinationArg = args.find((arg) => !arg.startsWith('--') && args[args.indexOf(arg) - 1]?.startsWith('--') !== true);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const tenantKey = value('--tenant-key');
const displayName = value('--display-name');
const dryRun = args.includes('--dry-run');

if (!destinationArg || !tenantKey || !displayName) {
  console.error('Usage: node scripts/init-peer.mjs <destination> --tenant-key <key> --display-name <name> [--dry-run]');
  process.exit(2);
}
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tenantKey)) {
  console.error('Tenant key must be normalized lower-case hyphen-case.');
  process.exit(2);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, '..');
const source = join(pluginRoot, 'skills', 'heroes-agent', 'assets', 'peer-template');
const references = join(pluginRoot, 'skills', 'heroes-agent', 'references');
const destination = resolve(destinationArg);
const destinationParent = dirname(destination);

if (existsSync(destination)) {
  console.error(`Refusing to overwrite existing destination: ${destination}`);
  process.exit(1);
}
if (dryRun) {
  console.log(JSON.stringify({
    destination,
    tenantKey,
    displayName,
    source,
    writesSecrets: false,
    createsEnvStub: true,
    apiUrl: HOSTED_API_URL,
  }, null, 2));
  process.exit(0);
}

mkdirSync(destinationParent, { recursive: true });
const staging = join(
  destinationParent,
  `.${basename(destination)}.heroes-agent-init-${process.pid}-${Date.now()}`,
);
try {
  mkdirSync(staging, { recursive: false });
  cpSync(source, staging, { recursive: true, errorOnExist: true });
  mkdirSync(join(staging, 'railways'), { recursive: true });
  cpSync(join(references, 'handshake.md'), join(staging, 'railways', 'handshake.md'));
  cpSync(join(references, 'rfq.md'), join(staging, 'railways', 'rfq.md'));
  const identityPath = join(staging, 'self', 'identity.md');
  const identity = readFileSync(identityPath, 'utf8')
    .replace('<tenant-key>', tenantKey)
    .replace('<display-name>', displayName);
  writeFileSync(identityPath, identity);

  const envExample = readFileSync(join(staging, 'self', '.env.example'), 'utf8');
  const envStub = envExample
    .replace(/^API_URL=.*$/m, `API_URL=${HOSTED_API_URL}`)
    .replace(/^API_KEY=.*$/m, 'API_KEY=');
  writeFileSync(join(staging, 'self', '.env'), envStub);

  writeFileSync(
    join(staging, 'README.md'),
    `# Heroes peer: ${displayName}\n\n` +
      `Tenant key: \`${tenantKey}\`.\n\n` +
      `Open ignored \`self/.env\`, set \`API_KEY\` for this tenant, and keep \`API_URL\` as \`${HOSTED_API_URL}\` ` +
      `unless you run local Heroes (\`http://localhost:3401/api\`). ` +
      `Then ask an agent with heroes-agent installed to operate from this directory.\n`,
  );
  renameSync(staging, destination);
} catch (error) {
  rmSync(staging, { recursive: true, force: true });
  throw error;
}
console.log(`Created peer workspace for ${tenantKey} at ${destination}`);
