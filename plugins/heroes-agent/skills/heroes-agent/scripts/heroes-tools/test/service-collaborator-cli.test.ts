import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ApiError, addServiceCollaborator } from '../lib';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(toolsDir, '..', '..', '..', '..');
const launcher = join(pluginRoot, 'scripts', 'run-tool.mjs');

type RecordedRequest = {
  method?: string;
  url?: string;
  apiKey?: string;
  body: Buffer;
};

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function collaboratorRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    serviceId: '11111111-1111-4111-8111-111111111111',
    collaboratorTenantId: 77,
    grantedByTenantId: 42,
    createdAt: '2026-10-16T00:00:00Z',
    updatedAt: '2026-10-16T00:00:00Z',
    ...overrides,
  };
}

function runTool(
  workspace: string,
  port: number,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveProcess) => {
    const child = spawn(process.execPath, [launcher, ...args], {
      cwd: workspace,
      env: { ...process.env, API_URL: `http://127.0.0.1:${port}/api`, API_KEY: 'test-only-key' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolveProcess({ code, stdout, stderr }));
  });
}

async function withServer(
  prefix: string,
  handler: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void,
  body: (context: {
    workspace: string;
    port: number;
    requests: RecordedRequest[];
  }) => Promise<void>,
): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const bodyBuf = await bodyOf(request);
    requests.push({
      method: request.method,
      url: request.url,
      apiKey: request.headers['x-api-key'] as string | undefined,
      body: bodyBuf,
    });
    handler(request, response, bodyBuf);
  });
  try {
    const port = await listen(server);
    await body({ workspace, port, requests });
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    rmSync(workspace, { recursive: true, force: true });
  }
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function stageBooking(workspace: string): string {
  const folder = join(workspace, 'payload');
  mkdirSync(folder);
  writeFileSync(join(folder, 'booking.pdf'), 'synthetic booking bytes');
  return folder;
}

test('addServiceCollaborator posts only collaboratorTenantKey and maps 201 as created', async () => {
  await withServer(
    'heroes-collab-helper-201-',
    (request, response) => {
      json(response, 201, { data: collaboratorRecord() });
    },
    async ({ port, requests }) => {
      const result = await addServiceCollaborator(
        { apiUrl: `http://127.0.0.1:${port}/api`, apiKey: 'test-only-key' },
        {
          serviceId: '11111111-1111-4111-8111-111111111111',
          apiKey: 'test-only-key',
          tenantKey: 'example-collaborator',
        },
      );

      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, 'POST');
      assert.equal(
        requests[0].url,
        '/api/services/11111111-1111-4111-8111-111111111111/collaborators',
      );
      assert.equal(requests[0].apiKey, 'test-only-key');
      assert.deepEqual(JSON.parse(requests[0].body.toString('utf8')), {
        collaboratorTenantKey: 'example-collaborator',
      });
      assert.equal(result.created, true);
      assert.equal(result.id, 11);
      assert.equal(result.tenantKey, 'example-collaborator');
    },
  );
});

test('addServiceCollaborator maps an already-active collaboration as created=false', async () => {
  await withServer(
    'heroes-collab-helper-200-',
    (_request, response) => {
      json(response, 200, { data: collaboratorRecord({ id: 11 }) });
    },
    async ({ port }) => {
      const result = await addServiceCollaborator(
        { apiUrl: `http://127.0.0.1:${port}/api`, apiKey: 'test-only-key' },
        {
          serviceId: '11111111-1111-4111-8111-111111111111',
          apiKey: 'test-only-key',
          tenantKey: 'example-collaborator',
        },
      );
      assert.equal(result.created, false);
      assert.equal(result.id, 11);
    },
  );
});

test('add-service-collaborator.ts posts each --tenant-key and prints the result', async () => {
  let call = 0;
  await withServer(
    'heroes-collab-cli-',
    (_request, response) => {
      call += 1;
      json(response, call === 1 ? 201 : 200, {
        data: collaboratorRecord({ id: call === 1 ? 11 : 12 }),
      });
    },
    async ({ workspace, port, requests }) => {
      const result = await runTool(workspace, port, [
        'add-service-collaborator.ts',
        '11111111-1111-4111-8111-111111111111',
        '--tenant-key',
        'example-collaborator',
        '--tenant-key',
        'example-taker',
      ]);

      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.deepEqual(
        requests.map((request) => `${request.method} ${request.url}`),
        [
          'POST /api/services/11111111-1111-4111-8111-111111111111/collaborators',
          'POST /api/services/11111111-1111-4111-8111-111111111111/collaborators',
        ],
      );
      assert.deepEqual(
        requests.map((request) => JSON.parse(request.body.toString('utf8'))),
        [
          { collaboratorTenantKey: 'example-collaborator' },
          { collaboratorTenantKey: 'example-taker' },
        ],
      );
      assert.match(result.stdout, /example-collaborator/);
      assert.match(result.stdout, /example-taker/);
      assert.doesNotMatch(result.stdout + result.stderr, /test-only-key/);
    },
  );
});

test('add-service-collaborator.ts exits non-zero and names the API code', async () => {
  const cases: Array<{ status: number; code: string }> = [
    { status: 409, code: 'SERVICE_COLLABORATION_CONFLICT' },
    { status: 403, code: 'SERVICE_CAPABILITY_DENIED' },
    { status: 404, code: 'NOT_FOUND' },
  ];

  for (const { status, code } of cases) {
    await withServer(
      'heroes-collab-cli-err-',
      (_request, response) => {
        json(response, status, {
          success: false,
          code,
          message: 'stubbed collaborator refusal',
        });
      },
      async ({ workspace, port, requests }) => {
        const result = await runTool(workspace, port, [
          'add-service-collaborator.ts',
          '11111111-1111-4111-8111-111111111111',
          '--tenant-key',
          'example-collaborator',
        ]);

        assert.equal(result.code, 1, result.stdout);
        assert.match(result.stderr, new RegExp(String(status)));
        assert.match(result.stderr, new RegExp(code));
        assert.equal(requests.length, 1);
      },
    );
  }
});

test('create-shipment without --collaborator makes the same requests as before', async () => {
  await withServer(
    'heroes-collab-regression-',
    (request, response) => {
      const url = request.url ?? '';
      if (url === '/api/journeys') return json(response, 201, { data: { id: 'journey-1' } });
      if (url === '/api/services') return json(response, 201, { data: { id: 'service-1' } });
      if (url === '/api/services/service-1/events') {
        return json(response, 201, { data: { id: 73 } });
      }
      if (url === '/api/events/attachments') return json(response, 201, { data: { id: 88 } });
      json(response, 404, { success: false, code: 'NOT_FOUND', message: 'not stubbed' });
    },
    async ({ workspace, port, requests }) => {
      const folder = stageBooking(workspace);
      const result = await runTool(workspace, port, [
        'create-shipment.ts',
        folder,
        '--target',
        'example-taker',
      ]);

      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.deepEqual(
        requests.map((request) => `${request.method} ${request.url}`),
        [
          'POST /api/journeys',
          'POST /api/services',
          'POST /api/services/service-1/events',
          'POST /api/events/attachments',
        ],
      );
      assert.equal(
        requests.some((request) => (request.url ?? '').includes('/collaborators')),
        false,
      );
      assert.deepEqual(JSON.parse(requests[1].body.toString('utf8')), {
        serviceKey: 'inland_transport',
        journeyId: 'journey-1',
      });
    },
  );
});

test('understanding: a collaborator is a follow-up POST after HANDSHAKE, not a create-time role', async () => {
  await withServer(
    'heroes-collab-create-',
    (request, response) => {
      const url = request.url ?? '';
      if (url === '/api/journeys') return json(response, 201, { data: { id: 'journey-1' } });
      if (url === '/api/services') return json(response, 201, { data: { id: 'service-1' } });
      if (url === '/api/services/service-1/collaborators') {
        return json(response, 201, { data: collaboratorRecord({ serviceId: 'service-1' }) });
      }
      if (url === '/api/services/service-1/events') {
        return json(response, 201, { data: { id: 73 } });
      }
      if (url === '/api/events/attachments') return json(response, 201, { data: { id: 88 } });
      json(response, 404, { success: false, code: 'NOT_FOUND', message: 'not stubbed' });
    },
    async ({ workspace, port, requests }) => {
      const folder = stageBooking(workspace);
      const result = await runTool(workspace, port, [
        'create-shipment.ts',
        folder,
        '--target',
        'example-taker',
        '--collaborator',
        'example-collaborator',
        '--collaborator',
        'example-taker',
      ]);

      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.deepEqual(
        requests.map((request) => `${request.method} ${request.url}`),
        [
          'POST /api/journeys',
          'POST /api/services',
          'POST /api/services/service-1/events',
          'POST /api/events/attachments',
          'POST /api/services/service-1/collaborators',
          'POST /api/services/service-1/collaborators',
        ],
      );

      const serviceBody = JSON.parse(requests[1].body.toString('utf8'));
      assert.equal('participantTenantKeys' in serviceBody, false);
      assert.equal('collaboratorTenantKey' in serviceBody, false);
      const handshake = JSON.parse(requests[2].body.toString('utf8'));
      assert.deepEqual(handshake.strategy, {
        strategyKey: 'HANDSHAKE',
        stepKey: 'INITIATED',
        targetTenantKey: 'example-taker',
      });
      assert.deepEqual(JSON.parse(requests[4].body.toString('utf8')), {
        collaboratorTenantKey: 'example-collaborator',
      });
      assert.deepEqual(JSON.parse(requests[5].body.toString('utf8')), {
        collaboratorTenantKey: 'example-taker',
      });
      assert.match(result.stdout, /example-collaborator/);
      assert.match(result.stdout, /example-taker/);
    },
  );
});

test('create-shipment collaborator 404 leaves HANDSHAKE in place and names the recovery command', async () => {
  await withServer(
    'heroes-collab-create-404-',
    (request, response) => {
      const url = request.url ?? '';
      if (url === '/api/journeys') return json(response, 201, { data: { id: 'journey-1' } });
      if (url === '/api/services') return json(response, 201, { data: { id: 'service-1' } });
      if (url === '/api/services/service-1/events') {
        return json(response, 201, { data: { id: 73 } });
      }
      if (url === '/api/events/attachments') return json(response, 201, { data: { id: 88 } });
      if (url === '/api/services/service-1/collaborators') {
        return json(response, 404, {
          success: false,
          code: 'NOT_FOUND',
          message: 'Tenant not found',
        });
      }
      json(response, 500, { success: false, code: 'UNEXPECTED', message: 'not stubbed' });
    },
    async ({ workspace, port, requests }) => {
      const folder = stageBooking(workspace);
      const result = await runTool(workspace, port, [
        'create-shipment.ts',
        folder,
        '--target',
        'example-taker',
        '--collaborator',
        'example-collaborator',
        '--collaborator',
        'example-taker',
      ]);

      assert.equal(result.code, 1, result.stdout);
      assert.deepEqual(
        requests.map((request) => `${request.method} ${request.url}`),
        [
          'POST /api/journeys',
          'POST /api/services',
          'POST /api/services/service-1/events',
          'POST /api/events/attachments',
          'POST /api/services/service-1/collaborators',
        ],
      );
      assert.deepEqual(JSON.parse(requests[2].body.toString('utf8')).strategy, {
        strategyKey: 'HANDSHAKE',
        stepKey: 'INITIATED',
        targetTenantKey: 'example-taker',
      });
      assert.match(result.stderr, /NOT_FOUND/);
      assert.match(result.stderr, /serviceId\s+service-1/);
      assert.match(
        result.stderr,
        /add-service-collaborator\.ts service-1 --tenant-key example-collaborator --tenant-key example-taker/,
      );
    },
  );
});

test('addServiceCollaborator surfaces the Heroes error code', async () => {
  await withServer(
    'heroes-collab-helper-err-',
    (_request, response) => {
      json(response, 409, {
        success: false,
        code: 'SERVICE_COLLABORATION_CONFLICT',
        message: 'stubbed collaborator refusal',
      });
    },
    async ({ port }) => {
      await assert.rejects(
        addServiceCollaborator(
          { apiUrl: `http://127.0.0.1:${port}/api`, apiKey: 'test-only-key' },
          {
            serviceId: '11111111-1111-4111-8111-111111111111',
            apiKey: 'test-only-key',
            tenantKey: 'example-collaborator',
          },
        ),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 409);
          assert.match(error.message, /SERVICE_COLLABORATION_CONFLICT/);
          return true;
        },
      );
    },
  );
});
