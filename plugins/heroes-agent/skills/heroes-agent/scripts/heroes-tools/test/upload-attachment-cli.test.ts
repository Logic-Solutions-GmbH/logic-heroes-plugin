import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(toolsDir, '..', '..', '..', '..');
const launcher = join(pluginRoot, 'scripts', 'run-tool.mjs');

test('operator can upload one payload to an existing event through the public launcher', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-upload-cli-'));
  const payloadFolder = join(workspace, 'payload');
  mkdirSync(payloadFolder);
  writeFileSync(join(payloadFolder, 'booking.pdf'), 'synthetic booking bytes');

  let request:
    | { method?: string; url?: string; apiKey?: string; contentType?: string; body: Buffer }
    | undefined;
  let requestCount = 0;
  const server = createServer((incoming, response) => {
    requestCount += 1;
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    incoming.on('end', () => {
      request = {
        method: incoming.method,
        url: incoming.url,
        apiKey: incoming.headers['x-api-key'] as string | undefined,
        contentType: incoming.headers['content-type'],
        body: Buffer.concat(chunks),
      };
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { id: 91 } }));
    });
  });

  try {
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolveProcess) => {
        const child = spawn(
          process.execPath,
          [launcher, 'upload-attachment.ts', '42', payloadFolder],
          {
            cwd: workspace,
            env: {
              ...process.env,
              API_URL: `http://127.0.0.1:${address.port}/api`,
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
    assert.ok(request, 'local Heroes boundary must receive one upload request');
    assert.equal(requestCount, 1);
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/events/attachments');
    assert.equal(request.apiKey, 'test-only-key');
    assert.match(request.contentType ?? '', /^multipart\/form-data; boundary=/);
    const body = request.body.toString('latin1');
    assert.match(body, /name="eventIds"\r\n\r\n42/);
    assert.match(body, /filename="booking.pdf"/);
    assert.match(body, /synthetic booking bytes/);
    assert.match(result.stdout, /eventId\s+42/);
    assert.match(result.stdout, /booking\.pdf/);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('public upload command formats structured multipart errors safely', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-upload-error-cli-'));
  const payloadFolder = join(workspace, 'payload');
  mkdirSync(payloadFolder);
  writeFileSync(join(payloadFolder, 'booking.pdf'), 'synthetic booking bytes');

  const server = createServer((_incoming, response) => {
    response.writeHead(422, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        message: { summary: 'Attachment rejected', detail: 'Event is not writable' },
      }),
    );
  });

  try {
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolveProcess) => {
        const child = spawn(
          process.execPath,
          [launcher, 'upload-attachment.ts', '42', payloadFolder],
          {
            cwd: workspace,
            env: {
              ...process.env,
              API_URL: `http://127.0.0.1:${address.port}/api`,
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
    assert.match(result.stderr, /422/);
    assert.match(result.stderr, /Attachment rejected/);
    assert.match(result.stderr, /Event is not writable/);
    assert.doesNotMatch(result.stderr, /\[object Object\]/);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    rmSync(workspace, { recursive: true, force: true });
  }
});
