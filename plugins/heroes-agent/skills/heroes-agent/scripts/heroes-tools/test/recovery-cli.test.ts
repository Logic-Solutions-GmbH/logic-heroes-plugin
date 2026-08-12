import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ApiError, api } from '../lib';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(toolsDir, '..', '..', '..', '..');
const launcher = join(pluginRoot, 'scripts', 'run-tool.mjs');

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

test('structured API errors show useful detail without object coercion', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(409, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        message: { summary: 'Journey creation failed', detail: 'Duplicate client reference' },
      }),
    );
  });

  try {
    const port = await listen(server);
    await assert.rejects(
      api(
        { apiUrl: `http://127.0.0.1:${port}/api`, apiKey: 'test-only-key' },
        { method: 'POST', path: '/journeys', apiKey: 'test-only-key', body: { type: 'SHIPMENT' } },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.match(error.message, /409/);
        assert.match(error.message, /Journey creation failed/);
        assert.match(error.message, /Duplicate client reference/);
        assert.doesNotMatch(error.message, /\[object Object\]/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
});

test('operator can resume shipment creation on an existing journey through the public launcher', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-resume-cli-'));
  const payloadFolder = join(workspace, 'payload');
  mkdirSync(payloadFolder);
  writeFileSync(join(payloadFolder, 'booking.pdf'), 'synthetic resumed booking bytes');

  const requests: { method?: string; url?: string; contentType?: string; body: Buffer }[] = [];
  const server = createServer(async (request, response) => {
    const body = await bodyOf(request);
    requests.push({
      method: request.method,
      url: request.url,
      contentType: request.headers['content-type'],
      body,
    });
    response.writeHead(201, { 'content-type': 'application/json' });
    if (request.url === '/api/services') response.end(JSON.stringify({ data: { id: 'service-7' } }));
    else if (request.url === '/api/services/service-7/events') response.end(JSON.stringify({ data: { id: 73 } }));
    else response.end(JSON.stringify({ data: { id: 88 } }));
  });

  try {
    const port = await listen(server);
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolveProcess) => {
        const child = spawn(
          process.execPath,
          [
            launcher,
            'create-shipment.ts',
            payloadFolder,
            '--target',
            'globex',
            '--journey-id',
            'journey-existing-4',
          ],
          {
            cwd: workspace,
            env: {
              ...process.env,
              API_URL: `http://127.0.0.1:${port}/api`,
              API_KEY: 'test-only-key',
            },
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('close', (code) => resolveProcess({ code, stdout, stderr }));
      },
    );

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.deepEqual(
      requests.map((request) => request.url),
      ['/api/services', '/api/services/service-7/events', '/api/events/attachments'],
    );
    assert.equal(requests.some((request) => request.url === '/api/journeys'), false);
    assert.deepEqual(JSON.parse(requests[0].body.toString('utf8')), {
      serviceKey: 'ltl_pickup_origin',
      journeyId: 'journey-existing-4',
    });
    const event = JSON.parse(requests[1].body.toString('utf8'));
    assert.deepEqual(event.strategy, {
      strategyKey: 'HANDSHAKE',
      stepKey: 'INITIATED',
      targetTenantKey: 'globex',
    });
    assert.match(requests[2].contentType ?? '', /^multipart\/form-data; boundary=/);
    const multipart = requests[2].body.toString('latin1');
    assert.match(multipart, /name="eventIds"\r\n\r\n73/);
    assert.match(multipart, /filename="booking.pdf"/);
    assert.match(multipart, /synthetic resumed booking bytes/);
    assert.match(result.stdout, /journeyId\s+journey-existing-4/);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('missing journey ID fails before shipment creation through the public launcher', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-resume-missing-cli-'));
  const payloadFolder = join(workspace, 'payload');
  mkdirSync(payloadFolder);
  writeFileSync(join(payloadFolder, 'booking.pdf'), 'synthetic resumed booking bytes');

  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: { id: 'unexpected-id' } }));
  });

  try {
    const port = await listen(server);
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolveProcess) => {
        const child = spawn(
          process.execPath,
          [
            launcher,
            'create-shipment.ts',
            payloadFolder,
            '--target',
            'globex',
            '--journey-id',
          ],
          {
            cwd: workspace,
            env: {
              ...process.env,
              API_URL: `http://127.0.0.1:${port}/api`,
              API_KEY: 'test-only-key',
            },
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('close', (code) => resolveProcess({ code, stdout, stderr }));
      },
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--journey-id requires a value/);
    assert.equal(requestCount, 0);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    rmSync(workspace, { recursive: true, force: true });
  }
});
