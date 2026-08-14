import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
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
      env: { ...process.env, API_URL: `http://127.0.0.1:${port}/api`, API_KEY: 'test-only-key' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolveProcess({ code, stdout, stderr }));
  });
}

/**
 * The Hapag-Lloyd door quote from references/offer.md: one OFFER, one ocean
 * service, three covered box sizes, a door origin AND a real load port.
 */
function hapagSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reference: 'W241001250784',
    issuer: { tenantKey: 'hapag-lloyd' },
    recipient: { tenantKey: 'hj-schryver-de' },
    services: [
      {
        rowId: 'svc-1',
        serviceKey: 'oceanfreight',
        locations: [
          { code: 'DELEV', role: 'origin', sequence: 0 },
          { code: 'BEANR', role: 'port_of_loading', sequence: 1 },
          { code: 'DOCAU', role: 'transshipment', sequence: 2 },
          { code: 'KYGCM', role: 'port_of_discharge', sequence: 3 },
        ],
        timeframes: [{ kind: 'validity', dateFrom: '2024-10-16', dateTo: '2024-11-30' }],
        subtypes: ['20DC', '40DC', '40HC'],
        charges: [
          { chargeKey: 'ocean-freight', amount: 2063, currency: 'EUR' },
          {
            chargeKey: 'origin-fuel',
            amount: 103.5,
            currency: 'EUR',
            meta: { basis: '23% of origin-landfreight', of: 450 },
          },
        ],
      },
    ],
    ...overrides,
  };
}

function writeSpec(workspace: string, spec: Record<string, unknown>): string {
  const path = join(workspace, 'offer-spec.json');
  writeFileSync(path, JSON.stringify(spec, null, 2));
  return path;
}

function stagedDocument(workspace: string, filename = 'quote.pdf'): string {
  const folder = join(workspace, 'quote');
  mkdirSync(folder);
  writeFileSync(join(folder, filename), 'synthetic carrier quotation bytes');
  return folder;
}

const KNOWN_LOCODES = new Set(['DELEV', 'BEANR', 'DOCAU', 'KYGCM']);

interface StubOptions {
  /** Tenant keys that exist in the network. */
  tenants?: string[];
  /** Participants POST /services echoes back. Defaults to the pair that was sent. */
  participantsFor?: (body: Record<string, any>) => unknown[];
  journeyCreate?: (response: ServerResponse) => void;
}

/** A Heroes stub that answers the reads compose-offer must do before any write. */
function heroesStub(requests: RecordedRequest[], options: StubOptions = {}) {
  const tenants = options.tenants ?? ['hapag-lloyd', 'hj-schryver-de'];
  let serviceCounter = 0;
  return createServer(async (request, response) => {
    const body = await bodyOf(request);
    requests.push({
      method: request.method,
      url: request.url,
      apiKey: request.headers['x-api-key'] as string | undefined,
      body,
    });
    const url = request.url ?? '';
    const json = (status: number, data: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data }));
    };

    if (url === '/api/catalog/services') {
      return json(200, { services: [{ serviceKey: 'oceanfreight' }, { serviceKey: 'airfreight' }] });
    }
    if (url === '/api/catalog/location-roles') {
      return json(200, {
        location_roles: [
          { code: 'origin', name: 'Origin', description: 'Start of the whole service' },
          { code: 'destination', name: 'Destination', description: 'End of the whole service' },
          { code: 'port_of_loading', name: 'Port of loading', description: 'Main leg load port' },
          { code: 'port_of_discharge', name: 'Port of discharge', description: 'Main leg discharge port' },
          { code: 'transshipment', name: 'Transshipment', description: 'Mid-water vessel change' },
          { code: 'depot', name: 'Depot', description: 'Depot' },
          { code: 'warehouse', name: 'Warehouse', description: 'Warehouse' },
        ],
      });
    }
    if (url === '/api/catalog/timeframe-kinds') {
      return json(200, {
        timeframe_kinds: [
          { code: 'validity', name: 'Validity', description: 'Offer validity window' },
          { code: 'departure_window', name: 'Departure window', description: 'Planned departure' },
          { code: 'arrival_deadline', name: 'Arrival deadline', description: 'Latest arrival' },
          { code: 'cargo_ready', name: 'Cargo ready', description: 'Cargo ready date' },
          { code: 'customs_clearance_by', name: 'Customs clearance by', description: 'Clearance deadline' },
        ],
      });
    }
    if (url === '/api/catalog/asset-types') {
      return json(200, { asset_types: [{ code: 'container' }] });
    }
    if (url === '/api/catalog/asset-subtypes?asset_type=container') {
      return json(200, {
        asset_subtypes: [{ subtype: '20DC' }, { subtype: '40DC' }, { subtype: '40HC' }],
      });
    }
    if (url.startsWith('/api/locodes/')) {
      const code = decodeURIComponent(url.slice('/api/locodes/'.length));
      if (!KNOWN_LOCODES.has(code)) {
        response.writeHead(404, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ success: false, error: `Locode ${code} not found` }));
      }
      return json(200, { code, name: code });
    }
    if (url.startsWith('/api/tenants/discover')) {
      const q = new URL(url, 'http://stub').searchParams.get('q') ?? '';
      return json(200, tenants.filter((key) => key.includes(q)).map((key, index) => ({
        id: index + 1, tenantKey: key, name: key,
      })));
    }
    if (url === '/api/journeys' && request.method === 'POST') {
      if (options.journeyCreate) return options.journeyCreate(response);
      return json(201, { id: 'offer-journey-1', type: 'OFFER' });
    }
    if (url === '/api/services' && request.method === 'POST') {
      serviceCounter += 1;
      const sent = JSON.parse(body.toString('utf8'));
      const participants = options.participantsFor
        ? options.participantsFor(sent)
        : [
            { id: 1, tenantId: 96, tenantKey: sent.participantTenantKeys?.issuer, role: 'issuer', references: [] },
            { id: 2, tenantId: 42, tenantKey: sent.participantTenantKeys?.recipient, role: 'recipient', references: [] },
          ];
      return json(201, { id: `offer-service-${serviceCounter}`, serviceKey: sent.serviceKey, participants });
    }
    if (url === '/api/journeys/offer-journey-1/strategy/advance' && request.method === 'POST') {
      return json(200, {
        count: 1,
        advanced: [{
          serviceId: 'offer-service-1', instanceId: 'instance-1', currentStep: 'QUOTED', eventId: 9001,
        }],
        skipped: [],
      });
    }
    if (url === '/api/events/attachments' && request.method === 'POST') return json(201, { id: 501 });
    if (request.method === 'DELETE') return json(200, {});
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ success: false, error: 'not stubbed' }));
  });
}

async function withStub(
  prefix: string,
  options: StubOptions,
  body: (context: {
    workspace: string;
    port: number;
    requests: RecordedRequest[];
  }) => Promise<void>,
): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  const requests: RecordedRequest[] = [];
  const server = heroesStub(requests, options);
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

const writeRequests = (requests: RecordedRequest[]) =>
  requests.filter((request) => request.method !== 'GET');

test('composing a held quote files one OFFER with issuer/recipient, POL/POD and offer_charges', async () => {
  await withStub('heroes-compose-offer-', {}, async ({ workspace, port, requests }) => {
    const specPath = writeSpec(workspace, hapagSpec());
    const attachment = stagedDocument(workspace);

    const result = await runTool(workspace, port, ['compose-offer.ts', specPath, '--attach', attachment]);
    assert.equal(result.code, 0, result.stderr || result.stdout);

    // Vocabularies come from the catalog reads; the OpenAPI document is never fetched.
    const urls = requests.map((request) => `${request.method} ${request.url}`);
    assert.ok(urls.includes('GET /api/catalog/location-roles'), urls.join('\n'));
    assert.ok(urls.includes('GET /api/catalog/timeframe-kinds'), urls.join('\n'));
    assert.equal(urls.some((url) => url.includes('openapi')), false);
    assert.equal(requests.every((request) => request.apiKey === 'test-only-key'), true);

    assert.deepEqual(writeRequests(requests).map((request) => `${request.method} ${request.url}`), [
      'POST /api/journeys',
      'POST /api/services',
      'POST /api/journeys/offer-journey-1/strategy/advance',
      'POST /api/events/attachments',
    ]);

    const [journeyBody, serviceBody, advanceRaw] = writeRequests(requests)
      .slice(0, 3)
      .map((request) => JSON.parse(request.body.toString('utf8')));

    assert.deepEqual(journeyBody, { type: 'OFFER' });

    // The OFFER relationship, stored as itself. No assignment role is invented.
    assert.deepEqual(serviceBody.participantTenantKeys, {
      issuer: 'hapag-lloyd',
      recipient: 'hj-schryver-de',
    });
    assert.equal('assigner' in serviceBody.participantTenantKeys, false);
    assert.equal('assignee' in serviceBody.participantTenantKeys, false);
    assert.equal(serviceBody.journeyId, 'offer-journey-1');
    assert.equal(serviceBody.serviceKey, 'oceanfreight');
    assert.deepEqual(serviceBody.locations, [
      { code: 'DELEV', role: 'origin', sequence: 0 },
      { code: 'BEANR', role: 'port_of_loading', sequence: 1 },
      { code: 'DOCAU', role: 'transshipment', sequence: 2 },
      { code: 'KYGCM', role: 'port_of_discharge', sequence: 3 },
    ]);
    // ISO strings on the wire, and one service covering three box sizes.
    assert.deepEqual(serviceBody.timeframes, [
      { kind: 'validity', dateFrom: '2024-10-16', dateTo: '2024-11-30' },
    ]);
    assert.deepEqual(serviceBody.subtypes, ['20DC', '40DC', '40HC']);

    assert.equal(advanceRaw.strategyKey, 'DIRECT_QUOTE');
    assert.equal(advanceRaw.stepKey, 'QUOTED');
    assert.equal(advanceRaw.targetTenantKey, 'hapag-lloyd');
    // `role` is the assignment-side hint; the recipient recording a held quote omits it.
    assert.equal('role' in advanceRaw, false);
    assert.equal(advanceRaw.name, 'Quotation W241001250784');
    assert.deepEqual(JSON.parse(advanceRaw.payload), {
      kind: 'offer_charges',
      schemaVersion: 2,
      journeyId: 'offer-journey-1',
      charges: [
        {
          serviceRowId: 'svc-1',
          heroesServiceId: 'offer-service-1',
          chargeKey: 'ocean-freight',
          amount: 2063,
          currency: 'EUR',
        },
        {
          serviceRowId: 'svc-1',
          heroesServiceId: 'offer-service-1',
          chargeKey: 'origin-fuel',
          amount: 103.5,
          currency: 'EUR',
          meta: { basis: '23% of origin-landfreight', of: 450 },
        },
      ],
    });

    const multipart = writeRequests(requests)[3].body.toString('latin1');
    assert.match(multipart, /name="eventIds"\r\n\r\n9001/);
    assert.match(multipart, /filename="quote.pdf"/);

    const printed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    assert.equal(printed.status, 'composed');
    assert.equal(printed.journeyId, 'offer-journey-1');
    assert.equal(printed.eventId, 9001);
    assert.deepEqual(printed.services, [
      { rowId: 'svc-1', serviceId: 'offer-service-1', serviceKey: 'oceanfreight' },
    ]);
    assert.doesNotMatch(result.stdout + result.stderr, /test-only-key/);
  });
});

test('a dry run prints the three wire bodies and writes nothing', async () => {
  await withStub('heroes-compose-offer-dry-', {}, async ({ workspace, port, requests }) => {
    const specPath = writeSpec(workspace, hapagSpec());
    const result = await runTool(workspace, port, ['compose-offer.ts', specPath, '--dry-run']);

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.deepEqual(writeRequests(requests), []);
    const printed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    assert.equal(printed.status, 'dry-run');
    assert.deepEqual(printed.journeyCreate.body, { type: 'OFFER' });
    assert.deepEqual(printed.serviceCreates[0].body.participantTenantKeys, {
      issuer: 'hapag-lloyd',
      recipient: 'hj-schryver-de',
    });
    assert.equal(printed.advance.body.strategyKey, 'DIRECT_QUOTE');
    assert.equal(printed.advance.body.targetTenantKey, 'hapag-lloyd');
  });
});

test('a location role outside the fetched catalog is refused before any write', async () => {
  await withStub('heroes-compose-offer-role-', {}, async ({ workspace, port, requests }) => {
    const spec = hapagSpec();
    (spec.services as any[])[0].locations[1].role = 'load_port';
    const specPath = writeSpec(workspace, spec);

    const result = await runTool(workspace, port, ['compose-offer.ts', specPath]);
    assert.equal(result.code, 4);
    assert.deepEqual(writeRequests(requests), []);
    const printed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    assert.equal(printed.reason, 'invalid_spec');
    assert.match(printed.issues.join('\n'), /"load_port" is not in GET \/catalog\/location-roles/);
    assert.match(printed.issues.join('\n'), /port_of_loading/);
  });
});

test('a timeframe kind outside the fetched catalog is refused before any write', async () => {
  await withStub('heroes-compose-offer-kind-', {}, async ({ workspace, port, requests }) => {
    const spec = hapagSpec();
    (spec.services as any[])[0].timeframes[0].kind = 'valid until';
    const specPath = writeSpec(workspace, spec);

    const result = await runTool(workspace, port, ['compose-offer.ts', specPath]);
    assert.equal(result.code, 4);
    assert.deepEqual(writeRequests(requests), []);
    const printed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    assert.match(printed.issues.join('\n'), /"valid until" is not in GET \/catalog\/timeframe-kinds/);
  });
});

test('an issuer outside the Heroes network stops the run instead of substituting a tenant', async () => {
  await withStub(
    'heroes-compose-offer-issuer-',
    { tenants: ['hj-schryver-de'] },
    async ({ workspace, port, requests }) => {
      const specPath = writeSpec(workspace, hapagSpec());
      const result = await runTool(workspace, port, ['compose-offer.ts', specPath]);

      assert.equal(result.code, 5);
      assert.deepEqual(writeRequests(requests), []);
      const printed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
      assert.equal(printed.reason, 'issuer_not_in_network');
      assert.equal(printed.issuerTenantKey, 'hapag-lloyd');
    },
  );
});

test('an unresolvable SCAC stops the run rather than inventing an issuer', async () => {
  await withStub('heroes-compose-offer-scac-', {}, async ({ workspace, port, requests }) => {
    const specPath = writeSpec(
      workspace,
      hapagSpec({ issuer: { providerCode: { type: 'scac', code: 'ZZZZ' } } }),
    );
    const result = await runTool(workspace, port, ['compose-offer.ts', specPath]);

    assert.equal(result.code, 5);
    assert.deepEqual(writeRequests(requests), []);
    const printed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    assert.equal(printed.reason, 'issuer_not_in_network');
    assert.deepEqual(printed.providerCode, { type: 'scac', code: 'ZZZZ' });
  });
});

test('a service that comes back without the relationship rows is released, not remapped', async () => {
  await withStub(
    'heroes-compose-offer-stripped-',
    {
      // A Heroes that still strips issuer/recipient: 201, but only assignment rows.
      participantsFor: () => [
        { id: 1, tenantId: 42, tenantKey: 'hj-schryver-de', role: 'assigner', references: [] },
      ],
    },
    async ({ workspace, port, requests }) => {
      const specPath = writeSpec(workspace, hapagSpec());
      const result = await runTool(workspace, port, ['compose-offer.ts', specPath]);

      assert.equal(result.code, 6);
      // Services first, then the journey this run minted. No advance was attempted.
      assert.deepEqual(writeRequests(requests).map((request) => `${request.method} ${request.url}`), [
        'POST /api/journeys',
        'POST /api/services',
        'DELETE /api/services/offer-service-1',
        'DELETE /api/journeys/offer-journey-1',
      ]);
      const printed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
      assert.equal(printed.reason, 'issuer_recipient_write_unavailable');
      assert.deepEqual(printed.expected, { issuer: 'hapag-lloyd', recipient: 'hj-schryver-de' });
      assert.deepEqual(printed.persisted, {});
      assert.deepEqual(printed.releasedServices, ['offer-service-1']);
      assert.equal(printed.releasedJourney, 'offer-journey-1');
      assert.match(printed.detail, /Do not remap issuer→assignee/);
    },
  );
});

test('a journey create whose outcome is unknown is never retried', async () => {
  await withStub(
    'heroes-compose-offer-lost-',
    {
      journeyCreate: (response) => {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: false, message: 'upstream timeout' }));
      },
    },
    async ({ workspace, port, requests }) => {
      const specPath = writeSpec(workspace, hapagSpec());
      const result = await runTool(workspace, port, ['compose-offer.ts', specPath]);

      assert.equal(result.code, 7);
      // Exactly one create attempt, and nothing after it.
      assert.deepEqual(writeRequests(requests).map((request) => `${request.method} ${request.url}`), [
        'POST /api/journeys',
      ]);
      const printed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
      assert.equal(printed.reason, 'journey_create_unconfirmed');
      assert.match(printed.nextStep, /Do NOT rerun this command/);
      assert.match(printed.nextStep, /--journey-id/);
    },
  );
});

test('an unresolvable place code is refused before any write', async () => {
  await withStub('heroes-compose-offer-locode-', {}, async ({ workspace, port, requests }) => {
    const spec = hapagSpec();
    (spec.services as any[])[0].locations[1].code = 'XXNOP';
    const specPath = writeSpec(workspace, spec);

    const result = await runTool(workspace, port, ['compose-offer.ts', specPath]);
    assert.equal(result.code, 4);
    assert.deepEqual(writeRequests(requests), []);
    const printed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    assert.match(printed.issues.join('\n'), /unknown UN\/LOCODE "XXNOP"/);
  });
});

test('a percentage charge must arrive as a computed number, not an expression', async () => {
  await withStub('heroes-compose-offer-charge-', {}, async ({ workspace, port, requests }) => {
    const spec = hapagSpec();
    (spec.services as any[])[0].charges[1].amount = '23% of origin-landfreight';
    const specPath = writeSpec(workspace, spec);

    const result = await runTool(workspace, port, ['compose-offer.ts', specPath]);
    assert.equal(result.code, 4);
    assert.deepEqual(requests, []);
    const printed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    assert.match(printed.issues.join('\n'), /amount must be a number/);
  });
});
