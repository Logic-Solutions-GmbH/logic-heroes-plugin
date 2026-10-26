import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(toolsDir, '..', '..', '..', '..');
const launcher = join(pluginRoot, 'scripts', 'run-tool.mjs');

const REAL = '11111111-1111-4111-8111-111111111111';
const SHADOW = '22222222-2222-4222-8222-222222222222';
const HIDDEN = '33333333-3333-4333-8333-333333333333';
const PO_ASSET = {
  id: 700,
  type: 'purchase_order',
  name: 'Purchase Order 4500012345',
  participants: [{ tenantId: 1, tenantKey: 'subsidiary', role: 'owner' }],
  externalRefs: [{ id: 9, assetId: 700, refType: 'purchase_order_number', refTypeId: 13, refId: '4500012345' }],
};

/** Read-only stub with the response shapes production returns (OpenAPI 0.1.282). */
function handler(requests: string[]) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const path = url.pathname.replace(/^\/api/, '');
    requests.push(`${req.method} ${path}${url.search}`);
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status < 400 ? { success: true, data } : { success: false, code: 'NOT_FOUND', message: 'Not found' }));
    };
    if (req.method !== 'GET') return json(405, {});
    if (path === '/catalog/asset-types') {
      return json(200, { asset_types: [{ code: 'purchase_order', name: 'Purchase Order', description: null }] });
    }
    if (path === '/catalog/reference-types') {
      return json(200, {
        reference_types: url.searchParams.get('asset_type') === 'purchase_order'
          ? [{ code: 'document_number', name: 'Document Number', description: null }, { code: 'purchase_order_number', name: 'Purchase Order Number', description: null }]
          : [],
      });
    }
    if (path === '/catalog/asset-subtypes') return json(200, { asset_subtypes: [] });
    if (path === '/assets/4500012345') return json(200, PO_ASSET);
    if (path.startsWith('/assets/')) return json(404, {});
    if (path === `/services/${REAL}/assets/manifest`) {
      return json(200, { manifest: [{ id: 41, serviceId: REAL, assetId: 700, role: 'document', asset: PO_ASSET }] });
    }
    if (path === `/services/${REAL}/assets`) {
      return json(200, { serviceAssets: [{ id: 41, serviceId: REAL, cargoAssetId: 700, transportAssetId: null, cargoAsset: PO_ASSET, transportAsset: null }] });
    }
    if (path === `/services/${SHADOW}/assets/manifest`) return json(200, { manifest: [] });
    if (path === `/services/${SHADOW}/assets`) return json(200, { serviceAssets: [] });
    if (path.endsWith('/assets/relationships') && !path.includes(HIDDEN)) return json(200, { relationships: [] });
    if (path.endsWith('/asset-events') && !path.includes(HIDDEN)) {
      return json(200, { assetEvents: [], pagination: { limit: null, offset: 0, total: 0, nextOffset: null } });
    }
    return json(404, {});
  };
}

async function runStatus(args: string[]) {
  const requests: string[] = [];
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-asset-status-'));
  const server = createServer(handler(requests));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath, [launcher, 'asset-status.ts', ...args], {
        cwd: workspace,
        env: { ...process.env, API_URL: `http://127.0.0.1:${address.port}/api`, API_KEY: 'test-only-key' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (code) => done({ code, stdout, stderr }));
    });
    return { ...result, requests };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(workspace, { recursive: true, force: true });
  }
}

test('asset-status reports type, catalog entry, ref validity and manifest roles, read-only', async () => {
  const { code, stdout, stderr, requests } = await runStatus([
    '--ref', '4500012345', '--ref', '999', '--service', REAL, '--service', SHADOW, '--service', HIDDEN, '--json',
  ]);
  assert.equal(code, 0, stderr);
  assert.ok(requests.every((r) => r.startsWith('GET ')), 'only GET requests');
  const out = JSON.parse(stdout);

  const [po, missing] = out.assets;
  assert.equal(po.id, 700);
  assert.equal(po.type, 'purchase_order');
  assert.deepEqual(po.catalogEntry, { code: 'purchase_order', name: 'Purchase Order', description: null });
  assert.deepEqual(po.externalRefs, [{ refType: 'purchase_order_number', refId: '4500012345', validForType: true }]);
  assert.deepEqual(po.subtypesForType, []);
  assert.deepEqual(missing, { refId: '999', found: false });
  assert.ok(requests.includes('GET /catalog/reference-types?asset_type=purchase_order'));

  const [real, shadow, hidden] = out.services;
  assert.deepEqual(real.manifest, [{ id: 41, assetId: 700, role: 'document', assetType: 'purchase_order' }]);
  assert.deepEqual(real.serviceAssets, [{ id: 41, cargoAssetId: 700, transportAssetId: null }]);
  assert.equal(real.notes.length, 1);
  assert.match(real.notes[0], /role document\) is also listed as cargoAssetId/);
  assert.deepEqual(shadow.manifest, []);
  assert.deepEqual(shadow.serviceAssets, []);
  assert.deepEqual(shadow.notes, []);
  assert.deepEqual(hidden, { serviceId: HIDDEN, visible: false });
});

test('asset-status without --ref or --service prints usage and fails', async () => {
  const { code, stderr, requests } = await runStatus([]);
  assert.notEqual(code, 0);
  assert.match(stderr, /Usage: npx tsx asset-status\.ts/);
  assert.deepEqual(requests, []);
});

test('asset-status is listed by list-heroes-tools', async () => {
  const child = spawn(process.execPath, [launcher, 'list-heroes-tools.ts', '--json'], { cwd: tmpdir() });
  let stdout = '';
  child.stdout.on('data', (c) => (stdout += c));
  await new Promise((r) => child.on('close', r));
  const tool = JSON.parse(stdout).tools.find((t: { name: string }) => t.name === 'asset-status.ts');
  assert.ok(tool, 'tool must be discoverable');
  assert.match(tool.summary, /read-only check of how assets are typed and bound/);
});
