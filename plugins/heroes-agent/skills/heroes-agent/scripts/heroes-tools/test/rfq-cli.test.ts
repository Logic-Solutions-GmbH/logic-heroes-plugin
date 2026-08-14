import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(toolsDir, '..', '..', '..', '..');
const launcher = join(pluginRoot, 'scripts', 'run-tool.mjs');

type RecordedRequest = {
  method?: string;
  url?: string;
  apiKey?: string;
  contentType?: string;
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

function runTool(
  workspace: string,
  port: number,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveProcess) => {
    const child = spawn(process.execPath, [launcher, ...args], {
      cwd: workspace,
      env: {
        ...process.env,
        API_URL: `http://127.0.0.1:${port}/api`,
        API_KEY: 'test-only-key',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolveProcess({ code, stdout, stderr }));
  });
}

function binaryPayload(workspace: string, folderName: string, filename: string, content: string): string {
  const folder = join(workspace, folderName);
  mkdirSync(folder);
  writeFileSync(join(folder, filename), content);
  return folder;
}

function recordRequest(request: IncomingMessage, body: Buffer): RecordedRequest {
  return {
    method: request.method,
    url: request.url,
    apiKey: request.headers['x-api-key'] as string | undefined,
    contentType: request.headers['content-type'],
    body,
  };
}

test('requester can resume RFQ on an existing journey through the public launcher', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rfq-request-'));
  const payload = binaryPayload(workspace, 'request', 'request.pdf', 'synthetic RFQ request bytes');
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    requests.push(recordRequest(request, await bodyOf(request)));
    response.writeHead(201, { 'content-type': 'application/json' });
    if (request.url === '/api/services') response.end(JSON.stringify({ data: { id: 'rfq-service-1' } }));
    else if (request.url === '/api/services/rfq-service-1/events') response.end(JSON.stringify({ data: { id: 101 } }));
    else response.end(JSON.stringify({ data: { id: 201 } }));
  });

  try {
    const port = await listen(server);
    const result = await runTool(workspace, port, [
      'request-quotation.ts', payload, '--target', 'globex', '--journey-id', 'journey-rfq-1',
    ]);

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.deepEqual(requests.map((request) => request.url), [
      '/api/services',
      '/api/services/rfq-service-1/events',
      '/api/events/attachments',
    ]);
    assert.equal(requests.every((request) => request.apiKey === 'test-only-key'), true);
    assert.deepEqual(JSON.parse(requests[0].body.toString('utf8')), {
      serviceKey: 'ltl_pickup_origin',
      journeyId: 'journey-rfq-1',
    });
    const event = JSON.parse(requests[1].body.toString('utf8'));
    assert.deepEqual(event.strategy, {
      strategyKey: 'RFQ', stepKey: 'REQUESTED', targetTenantKey: 'globex',
    });
    const multipart = requests[2].body.toString('latin1');
    assert.match(multipart, /name="eventIds"\r\n\r\n101/);
    assert.match(multipart, /filename="request.pdf"/);
    assert.match(multipart, /synthetic RFQ request bytes/);
    assert.match(result.stdout, /journeyId\s+journey-rfq-1/);
    assert.match(result.stdout, /serviceId\s+rfq-service-1/);
    assert.match(result.stdout, /request\.pdf \(multipart\)/);
    assert.doesNotMatch(result.stdout + result.stderr, /test-only-key/);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('missing RFQ journey ID fails before any public request', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rfq-request-missing-'));
  const payload = binaryPayload(workspace, 'request', 'request.pdf', 'synthetic RFQ request bytes');
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: { id: 'unexpected' } }));
  });

  try {
    const port = await listen(server);
    const result = await runTool(workspace, port, [
      'request-quotation.ts', payload, '--target', 'globex', '--journey-id',
    ]);
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

test('blank RFQ journey IDs fail before any public request', async () => {
  for (const journeyId of ['', '   ']) {
    const workspace = mkdtempSync(join(tmpdir(), 'heroes-rfq-request-blank-'));
    const payload = binaryPayload(workspace, 'request', 'request.pdf', 'synthetic RFQ request bytes');
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { id: 'unexpected' } }));
    });

    try {
      const port = await listen(server);
      const result = await runTool(workspace, port, [
        'request-quotation.ts', payload, '--target', 'globex', '--journey-id', journeyId,
      ]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /--journey-id requires a value/);
      assert.equal(requestCount, 0);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test('provider can quote an RFQ with one document through the public launcher', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rfq-quote-'));
  const payload = binaryPayload(workspace, 'quote', 'quote.pdf', 'synthetic quote bytes');
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    requests.push(recordRequest(request, await bodyOf(request)));
    response.writeHead(201, { 'content-type': 'application/json' });
    if (request.url === '/api/services/rfq-service-1/events') response.end(JSON.stringify({ data: { id: 102 } }));
    else response.end(JSON.stringify({ data: { id: 202 } }));
  });

  try {
    const port = await listen(server);
    const result = await runTool(workspace, port, [
      'quote-request.ts', 'rfq-service-1', payload, '--provider-ref', 'GLOBEX-Q-11',
    ]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
      'POST /api/services/rfq-service-1/events', 'POST /api/events/attachments',
    ]);
    assert.equal(requests.every((request) => request.apiKey === 'test-only-key'), true);
    const event = JSON.parse(requests[0].body.toString('utf8'));
    assert.deepEqual(event.strategy, {
      strategyKey: 'RFQ', stepKey: 'QUOTED', providerRef: 'GLOBEX-Q-11',
    });
    const multipart = requests[1].body.toString('latin1');
    assert.match(multipart, /name="eventIds"\r\n\r\n102/);
    assert.match(multipart, /filename="quote.pdf"/);
    assert.match(multipart, /synthetic quote bytes/);
    assert.match(result.stdout, /providerRef\s+GLOBEX-Q-11/);
    assert.match(result.stdout, /quote\.pdf \(multipart\)/);
    assert.doesNotMatch(result.stdout + result.stderr, /test-only-key/);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('requester can counter an RFQ with one document through the public launcher', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rfq-counter-'));
  const payload = binaryPayload(workspace, 'counter', 'counter.pdf', 'synthetic counter bytes');
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    requests.push(recordRequest(request, await bodyOf(request)));
    response.writeHead(201, { 'content-type': 'application/json' });
    if (request.url === '/api/services/rfq-service-1/events') response.end(JSON.stringify({ data: { id: 103 } }));
    else response.end(JSON.stringify({ data: { id: 203 } }));
  });

  try {
    const port = await listen(server);
    const result = await runTool(workspace, port, [
      'counter-quotation.ts', 'rfq-service-1', payload,
    ]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
      'POST /api/services/rfq-service-1/events', 'POST /api/events/attachments',
    ]);
    assert.equal(requests.every((request) => request.apiKey === 'test-only-key'), true);
    const event = JSON.parse(requests[0].body.toString('utf8'));
    assert.deepEqual(event.strategy, { strategyKey: 'RFQ', stepKey: 'COUNTERED' });
    const multipart = requests[1].body.toString('latin1');
    assert.match(multipart, /name="eventIds"\r\n\r\n103/);
    assert.match(multipart, /filename="counter.pdf"/);
    assert.match(multipart, /synthetic counter bytes/);
    assert.match(result.stdout, /counter\.pdf \(multipart\)/);
    assert.doesNotMatch(result.stdout + result.stderr, /test-only-key/);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('requester can accept an RFQ with one document through the public launcher', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rfq-accept-'));
  const payload = binaryPayload(workspace, 'accept', 'accept.pdf', 'synthetic acceptance bytes');
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    requests.push(recordRequest(request, await bodyOf(request)));
    response.writeHead(201, { 'content-type': 'application/json' });
    if (request.url === '/api/services/rfq-service-1/events') response.end(JSON.stringify({ data: { id: 104 } }));
    else response.end(JSON.stringify({ data: { id: 204 } }));
  });

  try {
    const port = await listen(server);
    const result = await runTool(workspace, port, [
      'accept-quotation.ts', 'rfq-service-1', payload,
    ]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
      'POST /api/services/rfq-service-1/events', 'POST /api/events/attachments',
    ]);
    assert.equal(requests.every((request) => request.apiKey === 'test-only-key'), true);
    const event = JSON.parse(requests[0].body.toString('utf8'));
    assert.deepEqual(event.strategy, { strategyKey: 'RFQ', stepKey: 'ACCEPTED' });
    const multipart = requests[1].body.toString('latin1');
    assert.match(multipart, /name="eventIds"\r\n\r\n104/);
    assert.match(multipart, /filename="accept.pdf"/);
    assert.match(multipart, /synthetic acceptance bytes/);
    assert.match(result.stdout, /accept\.pdf \(multipart\)/);
    assert.doesNotMatch(result.stdout + result.stderr, /test-only-key/);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('RFQ watcher observes a quote and downloads its document through the public launcher', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rfq-watch-'));
  const downloadDir = join(workspace, 'downloads');
  const requests: RecordedRequest[] = [];
  let strategyReads = 0;
  const server = createServer(async (request, response) => {
    const body = await bodyOf(request);
    requests.push(recordRequest(request, body));
    if (request.url === '/api/services/rfq-service-1/strategies') {
      strategyReads += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{
        id: 'rfq-instance-1', strategyKey: 'RFQ',
        currentStepKey: strategyReads === 1 ? 'REQUESTED' : 'QUOTED',
      }] }));
    } else if (request.url === '/api/services/rfq-service-1/events') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: strategyReads === 1
        ? [{ id: 1, name: 'Quotation Request' }]
        : [{ id: 1, name: 'Quotation Request' }, { id: 2, name: 'Quotation Provided' }] }));
    } else if (request.url === '/api/events/1/attachments') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { attachments: [] } }));
    } else if (request.url === '/api/events/2/attachments') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { attachments: [{
        id: 301, eventId: 2, originalFilename: 'quote.pdf', fileSize: 21,
      }] } }));
    } else if (request.url === '/api/events/attachments/301/download-url') {
      const port = (server.address() as { port: number }).port;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { url: `http://127.0.0.1:${port}/download/301` } }));
    } else if (request.url === '/download/301') {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end('expected watcher quote bytes');
    } else {
      response.writeHead(404).end();
    }
  });

  try {
    const port = await listen(server);
    const result = await runTool(workspace, port, [
      'watch-service.ts', 'rfq-service-1', '--interval', '0', '--timeout', '2',
      '--download-dir', downloadDir,
    ]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const apiRequests = requests.filter((request) => request.url?.startsWith('/api/'));
    assert.equal(apiRequests.every((request) => request.method === 'GET'), true);
    assert.equal(apiRequests.every((request) => request.apiKey === 'test-only-key'), true);
    assert.equal(requests.filter((request) => request.url === '/download/301').length, 1);
    assert.equal(requests.length, 9);
    assert.match(result.stdout, /RFQ\/REQUESTED.*RFQ\/QUOTED/s);
    assert.match(result.stdout, /quote\.pdf/);
    assert.match(result.stdout, /"changed": true/);
    assert.equal(readFileSync(join(downloadDir, 'quote.pdf'), 'utf8'), 'expected watcher quote bytes');
    assert.doesNotMatch(result.stdout + result.stderr, /test-only-key/);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    rmSync(workspace, { recursive: true, force: true });
  }
});
