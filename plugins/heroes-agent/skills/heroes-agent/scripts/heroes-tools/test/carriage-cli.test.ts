import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseServiceCarriage } from '../carriage';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(toolsDir, '..', '..', '..', '..');
const launcher = join(pluginRoot, 'scripts', 'run-tool.mjs');

type RecordedRequest = { method?: string; url?: string; body: Buffer };

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data }));
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

function payloadFolder(workspace: string): string {
  const folder = join(workspace, 'payload');
  mkdirSync(folder);
  writeFileSync(join(folder, 'request.pdf'), 'synthetic transport request');
  return folder;
}

function carriageFile(workspace: string, value: unknown): string {
  const path = join(workspace, 'carriage.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test('carriage validation mirrors the table presence rules', () => {
  assert.deepEqual(
    parseServiceCarriage('airfreight', {
      vehicleType: 'plane',
      vehicleAllocation: 'shared',
    }).issues,
    [],
  );
  assert.match(
    parseServiceCarriage('airfreight', {
      containerAllocation: 'none',
      vehicleType: 'plane',
      vehicleAllocation: 'shared',
    }).issues.join('\n'),
    /containerAllocation must be omitted/,
  );
  assert.match(
    parseServiceCarriage('oceanfreight', {
      containerAllocation: 'shared',
      vehicleType: 'vessel',
      vehicleAllocation: 'shared',
    }).issues.join('\n'),
    /handlingMethod is required/,
  );
  assert.match(
    parseServiceCarriage('inland_transport', {
      containerAllocation: 'none',
      vehicleType: 'truck',
      vehicleAllocation: 'exclusive',
      handlingMethod: 'lift_on_lift_off',
    }).issues.join('\n'),
    /handlingMethod must be omitted/,
  );
});

async function withServer(
  prefix: string,
  handler: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void,
  body: (context: { workspace: string; port: number; requests: RecordedRequest[] }) => Promise<void>,
): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const requestBody = await bodyOf(request);
    requests.push({ method: request.method, url: request.url, body: requestBody });
    handler(request, response, requestBody);
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

test('create-shipment reads carriage from a JSON file and sends it on POST /services', async () => {
  await withServer(
    'heroes-carriage-handshake-',
    (request, response) => {
      if (request.url === '/api/journeys') return json(response, 201, { id: 'journey-1' });
      if (request.url === '/api/services') return json(response, 201, { id: 'service-1' });
      if (request.url === '/api/services/service-1/events') return json(response, 201, { id: 71 });
      if (request.url === '/api/events/attachments') return json(response, 201, { id: 72 });
      json(response, 404, {});
    },
    async ({ workspace, port, requests }) => {
      const payload = payloadFolder(workspace);
      const carriage = carriageFile(workspace, {
        containerAllocation: 'none',
        vehicleType: 'truck',
        vehicleAllocation: 'exclusive',
      });
      const result = await runTool(workspace, port, [
        'create-shipment.ts', payload, '--target', 'globex', '--service-key', 'inland_transport',
        '--carriage', carriage,
      ]);

      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.deepEqual(JSON.parse(requests[1].body.toString('utf8')), {
        serviceKey: 'inland_transport',
        journeyId: 'journey-1',
        carriage: {
          containerAllocation: 'none',
          vehicleType: 'truck',
          vehicleAllocation: 'exclusive',
        },
      });
    },
  );
});

test('request-quotation reads air carriage from a JSON file', async () => {
  await withServer(
    'heroes-carriage-rfq-',
    (request, response) => {
      if (request.url === '/api/services') return json(response, 201, { id: 'service-2' });
      if (request.url === '/api/services/service-2/events') return json(response, 201, { id: 81 });
      if (request.url === '/api/events/attachments') return json(response, 201, { id: 82 });
      json(response, 404, {});
    },
    async ({ workspace, port, requests }) => {
      const payload = payloadFolder(workspace);
      const carriage = carriageFile(workspace, {
        vehicleType: 'plane',
        vehicleAllocation: 'shared',
      });
      const result = await runTool(workspace, port, [
        'request-quotation.ts', payload, '--target', 'globex', '--service-key', 'airfreight',
        '--journey-id', 'existing-journey', '--carriage', carriage,
      ]);

      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.deepEqual(JSON.parse(requests[0].body.toString('utf8')), {
        serviceKey: 'airfreight',
        journeyId: 'existing-journey',
        carriage: { vehicleType: 'plane', vehicleAllocation: 'shared' },
      });
    },
  );
});

test('CLI carriage on a non-transport key is refused before the first write', async () => {
  await withServer(
    'heroes-carriage-invalid-key-',
    (_request, response) => json(response, 500, {}),
    async ({ workspace, port, requests }) => {
      const payload = payloadFolder(workspace);
      const carriage = carriageFile(workspace, {
        containerAllocation: 'exclusive',
        vehicleType: 'vessel',
        vehicleAllocation: 'shared',
        handlingMethod: 'lift_on_lift_off',
      });
      const result = await runTool(workspace, port, [
        'create-shipment.ts', payload, '--target', 'globex', '--service-key', 'customs_clearance',
        '--carriage', carriage,
      ]);

      assert.equal(result.code, 1);
      assert.match(result.stderr, /carriage is not allowed.*customs_clearance/);
      assert.equal(requests.length, 0);
    },
  );
});

test('create-shipment maps definitive carriage rejections to exit 9 and releases its journey', async () => {
  for (const code of ['CARRIAGE_REQUIRED', 'CARRIAGE_NOT_ALLOWED']) {
    await withServer(
      `heroes-carriage-${code.toLowerCase()}-`,
      (request, response) => {
        if (request.url === '/api/journeys') return json(response, 201, { id: 'journey-refused' });
        if (request.url === '/api/services') {
          response.writeHead(400, { 'content-type': 'application/json' });
          return response.end(JSON.stringify({
            success: false,
            error: { code, message: 'stubbed carriage rejection' },
          }));
        }
        if (request.url === '/api/journeys/journey-refused' && request.method === 'DELETE') {
          return json(response, 200, {});
        }
        json(response, 404, {});
      },
      async ({ workspace, port, requests }) => {
        const result = await runTool(workspace, port, [
          'create-shipment.ts', payloadFolder(workspace), '--target', 'globex',
          '--service-key', 'inland_transport',
        ]);

        assert.equal(result.code, 9, result.stderr || result.stdout);
        assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
          'POST /api/journeys',
          'POST /api/services',
          'DELETE /api/journeys/journey-refused',
        ]);
        const printed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
        assert.equal(printed.reason, code);
        assert.equal(printed.releasedJourney, 'journey-refused');
      },
    );
  }
});

test('service-status shows declared carriage and the server consistency view', async () => {
  await withServer(
    'heroes-carriage-status-',
    (request, response) => {
      if (request.url === '/api/services/service-status-1') {
        return json(response, 200, {
          id: 'service-status-1',
          carriage: {
            containerAllocation: 'shared',
            vehicleType: 'vessel',
            vehicleAllocation: 'shared',
            handlingMethod: 'lift_on_lift_off',
            revision: 1,
          },
          carriageConsistency: {
            containerAllocation: { computed: 'consistent', evidence: [] },
            vehicleType: { computed: 'unknown', evidence: [] },
          },
        });
      }
      if (request.url === '/api/services/service-status-1/strategies') return json(response, 200, []);
      if (request.url === '/api/services/service-status-1/events') return json(response, 200, []);
      json(response, 404, {});
    },
    async ({ workspace, port, requests }) => {
      const result = await runTool(workspace, port, ['service-status.ts', 'service-status-1']);

      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.deepEqual(requests.map((request) => request.url), [
        '/api/services/service-status-1',
        '/api/services/service-status-1/strategies',
        '/api/services/service-status-1/events',
      ]);
      assert.match(result.stdout, /Carriage/);
      assert.match(result.stdout, /"containerAllocation": "shared"/);
      assert.match(result.stdout, /Carriage consistency/);
      assert.match(result.stdout, /"computed": "consistent"/);
    },
  );
});
