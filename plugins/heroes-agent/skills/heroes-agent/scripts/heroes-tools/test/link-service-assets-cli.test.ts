import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { defaultManifestRole, parseAssetSpec } from '../lib';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(toolsDir, '..', '..', '..', '..');
const launcher = join(pluginRoot, 'scripts', 'run-tool.mjs');

const SERVICE = '11111111-1111-4111-8111-111111111111';
const SHADOW = '22222222-2222-4222-8222-222222222222';

type Asset = {
  id: number;
  type: string;
  name: string;
  externalRefs: { id: number; assetId: number; refType: string; refTypeId: number; refId: string }[];
  participants: { tenantId: number; tenantKey: string; role: string }[];
};

/**
 * Stateful stub of the Heroes asset endpoints. Response shapes are the ones
 * production returned (OpenAPI 0.1.282 types them only as strings).
 */
function heroesStub(seed: Asset[] = []) {
  const assets = new Map<number, Asset>(seed.map((a) => [a.id, a]));
  const manifests = new Map<string, { id: number; assetId: number; role: string }[]>();
  const writes: { method: string; url: string; body: unknown }[] = [];
  let nextId = 500;
  const services: Record<string, { participants: { tenantKey: string; role: string }[] }> = {
    [SERVICE]: { participants: [{ tenantKey: 'subsidiary', role: 'assigner' }, { tenantKey: 'forwarder', role: 'assignee' }] },
    [SHADOW]: { participants: [{ tenantKey: 'forwarder', role: 'assigner' }, { tenantKey: 'integrator', role: 'assignee' }] },
  };
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status < 400 ? { success: true, data } : { success: false, error: data }));
  };
  const handler = (req: IncomingMessage, res: ServerResponse, raw: string) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const path = url.pathname.replace(/^\/api/, '');
    const body = raw ? JSON.parse(raw) : undefined;
    if (req.method !== 'GET') writes.push({ method: req.method ?? '', url: path, body });
    let m: RegExpMatchArray | null;
    if (req.method === 'GET' && path === '/catalog/asset-types') {
      return json(res, 200, {
        asset_types: [
          { code: 'purchase_order', name: 'Purchase Order', description: null },
          { code: 'container', name: 'Container', description: null },
          { code: 'vessel', name: 'Vessel', description: null },
        ],
      });
    }
    if (req.method === 'GET' && (m = path.match(/^\/services\/([^/]+)$/))) {
      const svc = services[m[1]];
      return svc ? json(res, 200, { id: m[1], ...svc }) : json(res, 404, { code: 'NOT_FOUND', message: 'Service not found' });
    }
    if (req.method === 'GET' && (m = path.match(/^\/assets\/(.+)$/))) {
      const refId = decodeURIComponent(m[1]);
      const hit = [...assets.values()].find((a) => a.externalRefs.some((r) => r.refId === refId));
      return hit ? json(res, 200, hit) : json(res, 404, { code: 'NOT_FOUND', message: `Asset ${refId} not found` });
    }
    if (req.method === 'POST' && path === '/assets') {
      const existing = [...assets.values()].find((a) =>
        a.externalRefs.some((r) => r.refType === body.externalRef.refType && r.refId === body.externalRef.refId));
      if (existing) return json(res, 200, existing);
      const id = nextId++;
      const asset: Asset = {
        id,
        type: body.type,
        name: body.name,
        externalRefs: [{ id: id + 1000, assetId: id, refType: body.externalRef.refType, refTypeId: 13, refId: body.externalRef.refId }],
        participants: [{ tenantId: 1, tenantKey: 'subsidiary', role: 'owner' }],
      };
      assets.set(id, asset);
      return json(res, 201, asset);
    }
    if ((m = path.match(/^\/services\/([^/]+)\/assets\/manifest$/))) {
      if (!services[m[1]]) return json(res, 404, { code: 'NOT_FOUND', message: 'Service not found' });
      const list = manifests.get(m[1]) ?? [];
      if (req.method === 'GET') {
        return json(res, 200, {
          manifest: list.map((e) => ({ ...e, serviceId: m![1], createdAt: '2026-10-26T00:00:00Z', asset: assets.get(e.assetId) })),
        });
      }
      for (const entry of body.entries) {
        if (!list.some((e) => e.assetId === entry.assetId && e.role === entry.role)) {
          list.push({ id: list.length + 1, assetId: entry.assetId, role: entry.role });
        }
      }
      manifests.set(m[1], list);
      return json(res, 201, { manifest: list });
    }
    return json(res, 404, { code: 'NOT_FOUND', message: `not stubbed: ${req.method} ${path}` });
  };
  return { assets, manifests, writes, handler };
}

async function withStub(
  stub: ReturnType<typeof heroesStub>,
  body: (run: (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>) => Promise<void>,
) {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-assets-'));
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => stub.handler(req, res, raw));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const run = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath, [launcher, 'link-service-assets.ts', ...args], {
        cwd: workspace,
        env: { ...process.env, API_URL: `http://127.0.0.1:${address.port}/api`, API_KEY: 'test-only-key' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (code) => done({ code, stdout, stderr }));
    });
  try {
    await body(run);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(workspace, { recursive: true, force: true });
  }
}

const PO = 'purchase_order:purchase_order_number:4500012345';

test('parseAssetSpec and defaultManifestRole follow the asset model', () => {
  assert.deepEqual(parseAssetSpec(PO), { type: 'purchase_order', refType: 'purchase_order_number', refId: '4500012345' });
  assert.equal(parseAssetSpec('container:container_number:AB:12').refId, 'AB:12');
  assert.throws(() => parseAssetSpec('purchase_order:po:1'), /unknown refType/);
  assert.throws(() => parseAssetSpec('purchase_order:purchase_order_number:'), /must be/);
  assert.equal(defaultManifestRole('purchase_order'), 'document');
  assert.equal(defaultManifestRole('container'), 'cargo');
  assert.equal(defaultManifestRole('vessel'), 'transport');
});

test('declares a missing asset, links it, and a retry writes nothing', async () => {
  const stub = heroesStub();
  await withStub(stub, async (run) => {
    const first = await run([SERVICE, '--asset', PO, '--expect-assignee', 'forwarder', '--json']);
    assert.equal(first.code, 0, first.stderr);
    const out = JSON.parse(first.stdout);
    assert.equal(out.assets[0].created, true);
    assert.equal(out.assets[0].role, 'document');
    assert.deepEqual(stub.writes, [
      {
        method: 'POST',
        url: '/assets',
        body: { type: 'purchase_order', name: 'Purchase Order 4500012345', externalRef: { refType: 'purchase_order_number', refId: '4500012345' } },
      },
      { method: 'POST', url: `/services/${SERVICE}/assets/manifest`, body: { entries: [{ assetId: 500, role: 'document' }] } },
    ]);

    const second = await run([SERVICE, '--asset', PO, '--expect-assignee', 'forwarder', '--json']);
    assert.equal(second.code, 0, second.stderr);
    const again = JSON.parse(second.stdout);
    assert.equal(again.assets[0].assetId, 500);
    assert.equal(again.assets[0].source, 'lookup');
    assert.deepEqual(again.linksAdded, []);
    assert.equal(stub.writes.length, 2, 'retry must not write');
    assert.equal(stub.assets.size, 1);
    assert.equal(stub.manifests.get(SERVICE)?.length, 1);
  });
});

test('reuses an existing shipment asset instead of creating one', async () => {
  const stub = heroesStub([
    {
      id: 77,
      type: 'purchase_order',
      name: 'PO 4500012345',
      externalRefs: [{ id: 1, assetId: 77, refType: 'purchase_order_number', refTypeId: 13, refId: '4500012345' }],
      participants: [],
    },
  ]);
  await withStub(stub, async (run) => {
    const result = await run([SERVICE, '--asset', PO, '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(stub.writes.map((w) => w.url), [`/services/${SERVICE}/assets/manifest`]);
    assert.deepEqual(stub.writes[0].body, { entries: [{ assetId: 77, role: 'document' }] });
  });
});

test('refuses when the reference belongs to a different kind of asset', async () => {
  const stub = heroesStub([
    {
      id: 78,
      type: 'container',
      name: 'Container 4500012345',
      externalRefs: [{ id: 2, assetId: 78, refType: 'container_number', refTypeId: 1, refId: '4500012345' }],
      participants: [],
    },
  ]);
  await withStub(stub, async (run) => {
    const result = await run([SERVICE, '--asset', PO]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Refusing to create a duplicate/);
    assert.deepEqual(stub.writes, []);
  });
});

test('--expect-assignee keeps assets off an integration-only service', async () => {
  const stub = heroesStub();
  await withStub(stub, async (run) => {
    const result = await run([SHADOW, '--asset', PO, '--expect-assignee', 'forwarder']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /assignee "integrator", not "forwarder"/);
    assert.deepEqual(stub.writes, []);
    assert.equal(stub.manifests.get(SHADOW), undefined);
  });
});

test('--dry-run reads but never writes', async () => {
  const stub = heroesStub();
  await withStub(stub, async (run) => {
    const result = await run([SERVICE, '--asset', PO, '--dry-run', '--json']);
    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.assets[0].planned.path, '/assets');
    assert.deepEqual(stub.writes, []);
  });
});

test('rejects an asset type missing from the catalog before any write', async () => {
  const stub = heroesStub();
  await withStub(stub, async (run) => {
    const result = await run([SERVICE, '--asset', 'spaceship:custom_ref:X1']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not in GET \/catalog\/asset-types/);
    assert.deepEqual(stub.writes, []);
  });
});

test('link-service-assets is listed by list-heroes-tools', async () => {
  const child = spawn(process.execPath, [launcher, 'list-heroes-tools.ts', '--json'], { cwd: tmpdir() });
  let stdout = '';
  child.stdout.on('data', (c) => (stdout += c));
  await new Promise((r) => child.on('close', r));
  const tool = JSON.parse(stdout).tools.find((t: { name: string }) => t.name === 'link-service-assets.ts');
  assert.ok(tool, 'tool must be discoverable');
  assert.match(tool.summary, /declare shipment assets/);
});
