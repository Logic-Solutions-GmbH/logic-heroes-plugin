/**
 * Shared helpers for the Logic Heroes peer Workspace scripts.
 *
 * Zero runtime dependencies — uses only Node built-ins (fetch, FormData, Blob,
 * fs, path), all available on Node 18+. Vendored from `heroes-demo-kit` and
 * trimmed to the single-peer model: one Workspace = one Heroes identity = one
 * API key. Maker/taker is a per-move fact (see docs/adr/0002), never a
 * per-identity one, so there is exactly one key to configure — no maker/taker
 * split.
 */
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join, extname } from 'node:path';

// ---------------------------------------------------------------------------
// Config & environment
// ---------------------------------------------------------------------------

export interface Config {
  apiUrl: string;
  /** This peer's own Heroes API key. Undefined until set — see requireApiKey(). */
  apiKey?: string;
}

/**
 * Minimal `.env` parser so we don't need the `dotenv` dependency.
 *
 * Reads, in order of precedence (first hit wins per key): `self/.env` then
 * `.env`, both relative to the current working directory. `self/.env` is the
 * canonical location a peer Workspace documents (config lives beside identity in
 * `self/`); the root `.env` remains supported for a flat layout.
 *
 * Deliberately overrides any value already in `process.env`, rather than
 * deferring to it: each peer folder is meant to be a completely isolated
 * identity, so this folder's own file must always win over anything a shell
 * happened to inherit (a stale `export`, a different peer's `.env` sourced
 * earlier in the same terminal, a shared profile). Isolation lives in the
 * filesystem, not in whichever env var got set first.
 */
function loadDotEnv(): void {
  const setFromFile = new Set<string>();
  for (const rel of ['self/.env', '.env']) {
    const path = join(process.cwd(), rel);
    if (!existsSync(path)) continue;
    for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // self/.env is read first, so it wins over .env for the same key; but
      // either always wins over whatever the shell already had — see the
      // isolation note above.
      if (setFromFile.has(key)) continue;
      process.env[key] = value;
      setFromFile.add(key);
    }
  }
}

export function loadConfig(): Config {
  loadDotEnv();
  return {
    apiUrl: (process.env.API_URL ?? 'http://localhost:3401/api').replace(/\/$/, ''),
    apiKey: process.env.API_KEY,
  };
}

/**
 * This peer's own Heroes API key. Every network-calling script needs it; local
 * file-only scripts (ingest-rates, find-rate) never call this, so they work
 * without any key configured.
 */
export function requireApiKey(config: Config): string {
  if (config.apiKey) return config.apiKey;
  throw new Error(
    'No API_KEY set. Open self/.env and fill in this peer\'s Heroes API key.',
  );
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  apiKey: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
}

function apiErrorDetail(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    const parts = value.map(apiErrorDetail).filter((part): part is string => !!part);
    return parts.length ? parts.join('; ') : undefined;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['message', 'error', 'summary', 'detail', 'details', 'title']) {
    const part = apiErrorDetail(record[key]);
    if (part && !parts.includes(part)) parts.push(part);
  }
  return parts.length ? parts.join(': ') : undefined;
}

/** Call a JSON endpoint and return the unwrapped `data` field. */
export async function api<T = any>(config: Config, opts: ApiOptions): Promise<T> {
  const url = new URL(config.apiUrl + opts.path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    method: opts.method,
    headers: {
      'x-api-key': opts.apiKey,
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  if (!res.ok) {
    // The API returns rich messages (e.g. "Only the target tenant can accept
    // or reject a handshake request") — surface them verbatim.
    const message =
      apiErrorDetail(json?.message ?? json?.error ?? json) ??
      (text && !json ? text : undefined) ??
      res.statusText;
    throw new ApiError(res.status, `${res.status} ${message}`, json);
  }

  return (json?.data ?? json) as T;
}

// ---------------------------------------------------------------------------
// Payload folders & attachments
// ---------------------------------------------------------------------------

/** Inline-payload size cap enforced by the API (event.payload max length). */
const INLINE_LIMIT = 8192;

const MIME: Record<string, string> = {
  json: 'application/json',
  xml: 'application/xml',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  pdf: 'application/pdf',
  edi: 'application/edi-x12',
};

export interface Payload {
  filename: string;
  ext: string;
  contentType: string;
  data: Buffer;
}

/**
 * Read the single payload file out of a folder. Format-agnostic: the file can
 * be JSON, XML, or anything else — the content type is inferred from the
 * extension and defaults to application/octet-stream.
 */
export function readPayloadFolder(folder: string): Payload {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new Error(`Payload folder not found: ${folder}`);
  }
  const files = readdirSync(folder).filter(
    (f) => !f.startsWith('.') && statSync(join(folder, f)).isFile(),
  );
  if (files.length === 0) throw new Error(`No payload file found in ${folder}`);
  if (files.length > 1) {
    throw new Error(
      `Expected exactly one payload file in ${folder}, found ${files.length}: ${files.join(', ')}`,
    );
  }
  const filename = files[0];
  const ext = extname(filename).slice(1).toLowerCase();
  return {
    filename,
    ext,
    contentType: MIME[ext] ?? 'application/octet-stream',
    data: readFileSync(join(folder, filename)),
  };
}

function isTextLike(contentType: string): boolean {
  return (
    contentType.startsWith('text/') ||
    contentType === 'application/json' ||
    contentType === 'application/xml'
  );
}

/** Upload a payload as a multipart attachment against an already-created event. */
export async function uploadAttachment(
  config: Config,
  apiKey: string,
  eventId: number | string,
  payload: Payload,
): Promise<void> {
  const form = new FormData();
  form.append(
    'file',
    new Blob([payload.data], { type: payload.contentType }),
    payload.filename,
  );
  form.append('eventIds', String(eventId));

  const res = await fetch(`${config.apiUrl}/events/attachments`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey }, // let fetch set the multipart boundary
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    const message =
      apiErrorDetail(json?.message ?? json?.error ?? json) ??
      (text && !json ? text : undefined) ??
      res.statusText;
    throw new ApiError(
      res.status,
      `Attachment upload failed: ${res.status} ${message}`,
      json,
    );
  }
}

export interface EventBody {
  name: string;
  eventAt?: string;
  eventType?: 'ACT' | 'PLN' | 'EST';
  loCode?: string;
  strategy?: Record<string, unknown>;
  payload?: string;
  payloadMeta?: { contentType?: string; filename?: string; ext?: string };
}

export interface CreatedEvent {
  event: any;
  attachmentMode: 'none' | 'inline' | 'multipart';
}

/**
 * Create an event on a service and, if a payload is supplied, attach it.
 *
 * Auto strategy: small text payloads (≤8 KB, text/json/xml) ride inline on the
 * event's `payload` field in a single request; anything larger or binary is
 * uploaded afterwards via the multipart attachments endpoint.
 */
export async function createEventWithAttachment(
  config: Config,
  args: { serviceId: string; apiKey: string; event: EventBody; payload?: Payload },
): Promise<CreatedEvent> {
  const body: EventBody = {
    eventType: 'ACT',
    eventAt: new Date().toISOString(),
    ...args.event,
  };

  const { payload } = args;
  const inline =
    !!payload &&
    isTextLike(payload.contentType) &&
    payload.data.toString('utf8').length <= INLINE_LIMIT;

  if (payload && inline) {
    body.payload = payload.data.toString('utf8');
    body.payloadMeta = {
      contentType: payload.contentType,
      filename: payload.filename,
      ext: payload.ext,
    };
  }

  const event = await api<any>(config, {
    method: 'POST',
    path: `/services/${args.serviceId}/events`,
    apiKey: args.apiKey,
    body,
  });

  if (payload && !inline) {
    await uploadAttachment(config, args.apiKey, event.id, payload);
  }

  return { event, attachmentMode: payload ? (inline ? 'inline' : 'multipart') : 'none' };
}

// ---------------------------------------------------------------------------
// Service snapshots & attachment download (status + watch)
// ---------------------------------------------------------------------------

export interface StrategyInstance {
  id: string;
  strategyKey: string;
  stepKey: string;
  startedAt?: string;
  completedAt?: string | null;
}

export interface ServiceEvent {
  id: number;
  name: string;
  source?: string;
  eventType?: string;
  loCode?: string;
  createdAt?: string;
  eventAt?: string;
}

export interface Attachment {
  id: number;
  eventId: number;
  filename: string;
  mimeType?: string;
  fileSize?: number;
  createdAt?: string;
}

export interface ServiceSnapshot {
  instances: StrategyInstance[];
  events: ServiceEvent[];
  attachments: Attachment[];
}

/**
 * One read of everything human-meaningful on a service: strategy instances (+
 * current step), events, and every event's attachments — folded into a single
 * object. Replaces the strategies → events → per-event-attachments call chain
 * you'd otherwise run by hand.
 */
export async function fetchSnapshot(
  config: Config,
  apiKey: string,
  serviceId: string,
): Promise<ServiceSnapshot> {
  const strategiesRaw = await api<any>(config, {
    method: 'GET',
    path: `/services/${serviceId}/strategies`,
    apiKey,
  });
  const rawInstances: any[] = Array.isArray(strategiesRaw)
    ? strategiesRaw
    : (strategiesRaw?.instances ?? []);
  const instances: StrategyInstance[] = rawInstances.map((i) => ({
    id: i.id ?? i.instanceId,
    strategyKey: i.strategyKey ?? i.strategy?.strategyKey ?? 'HANDSHAKE',
    stepKey: i.currentStepKey ?? i.currentStep?.key ?? '—',
    startedAt: i.startedAt,
    completedAt: i.completedAt,
  }));

  const eventsRaw = await api<any>(config, {
    method: 'GET',
    path: `/services/${serviceId}/events`,
    apiKey,
  });
  const events: ServiceEvent[] = (Array.isArray(eventsRaw) ? eventsRaw : []).map((e) => ({
    id: e.id,
    name: e.name,
    source: e.source,
    eventType: e.eventType,
    loCode: e.loCode,
    createdAt: e.createdAt,
    eventAt: e.eventAt,
  }));

  const attachments: Attachment[] = [];
  for (const ev of events) {
    const attRaw = await api<any>(config, {
      method: 'GET',
      path: `/events/${ev.id}/attachments`,
      apiKey,
    });
    const list: any[] = attRaw?.attachments ?? (Array.isArray(attRaw) ? attRaw : []);
    for (const a of list) {
      attachments.push({
        id: a.id,
        eventId: a.eventId ?? ev.id,
        filename: a.originalFilename ?? a.filename ?? `attachment-${a.id}`,
        mimeType: a.mimeType,
        fileSize: a.fileSize,
        createdAt: a.createdAt,
      });
    }
  }

  return { instances, events, attachments };
}

/** Resolve a short-lived CDN download URL for an attachment. */
export async function attachmentDownloadUrl(
  config: Config,
  apiKey: string,
  attachmentId: number,
): Promise<string> {
  const data = await api<any>(config, {
    method: 'GET',
    path: `/events/attachments/${attachmentId}/download-url`,
    apiKey,
  });
  const url = data?.url ?? data;
  if (typeof url !== 'string') {
    throw new Error(`No download URL returned for attachment ${attachmentId}`);
  }
  return url;
}

/** Download an attachment's bytes into `dir`, returning the written file path. */
export async function downloadAttachment(
  config: Config,
  apiKey: string,
  att: Attachment,
  dir: string,
): Promise<string> {
  const url = await attachmentDownloadUrl(config, apiKey, att.id);
  const res = await fetch(url);
  if (!res.ok) {
    throw new ApiError(res.status, `Download failed for ${att.filename}: ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dir, { recursive: true });
  const path = join(dir, att.filename);
  writeFileSync(path, buf);
  return path;
}

/** Sleep helper for polling loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Rate-book (CSV) — the provider's own price list
// ---------------------------------------------------------------------------
//
// A peer that provides service deposits its rate sheets and the agent quotes
// from them autonomously. We keep the store as plain CSV — zero dependency,
// legible (open it in Excel), diff-able, and it survives a cold "unzip and run"
// hand-off with nothing to install. Ingestion normalizes heterogeneous inputs
// once into a canonical CSV; retrieval (find-rate) filters only the matching
// rows, so the source file is never re-opened and never lands in the agent's
// context — that's the "big file" guard.

export interface RateRow {
  origin: string;
  dest: string;
  equipment: string;
  carrier: string;
  price: string;
  currency: string;
  validFrom: string;
  validTo: string;
  surcharges: string;
  sourceFile: string;
  sourceRef: string;
  ingestedAt: string;
}

/** Canonical column order of the normalized rate-book. */
export const RATE_COLUMNS: (keyof RateRow)[] = [
  'origin',
  'dest',
  'equipment',
  'carrier',
  'price',
  'currency',
  'validFrom',
  'validTo',
  'surcharges',
  'sourceFile',
  'sourceRef',
  'ingestedAt',
];

/** RFC-4180-ish parser: handles quoted fields, escaped `""`, embedded commas/newlines. */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvCell(v: string): string {
  const s = v ?? '';
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Serialize rows to CSV text (trailing newline). */
export function stringifyCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

/** Parse CSV using the first row as the header, yielding one object per data row. */
export function csvToObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows
    .slice(1)
    .filter((r) => r.some((c) => (c ?? '').trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/** Serialize objects to CSV in a fixed column order. */
export function objectsToCsv(objs: Record<string, unknown>[], columns: string[]): string {
  const rows = [columns, ...objs.map((o) => columns.map((c) => String(o[c] ?? '')))];
  return stringifyCsv(rows);
}

const normKey = (s: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Header synonyms per canonical column (all pre-normalized). Deliberately avoids
// bare "from"/"to" for validity so they don't collide with origin/dest.
const RATE_SYNONYMS: Partial<Record<keyof RateRow, string[]>> = {
  origin: ['origin', 'pol', 'portofloading', 'loadport', 'from', 'originport', 'originlocode', 'origincode', 'placeofreceipt', 'por'],
  dest: ['dest', 'destination', 'pod', 'portofdischarge', 'dischargeport', 'to', 'destport', 'destinationport', 'destinationlocode', 'destcode', 'placeofdelivery', 'fnd'],
  equipment: ['equipment', 'equipmenttype', 'container', 'containertype', 'equip', 'ctr', 'cntr', 'cntrtype', 'sizetype', 'size', 'type', 'box'],
  carrier: ['carrier', 'line', 'shippingline', 'scac', 'carriername'],
  price: ['price', 'rate', 'amount', 'allin', 'allinrate', 'total', 'totalrate', 'freight', 'freightrate', 'baserate'],
  currency: ['currency', 'curr', 'ccy'],
  validFrom: ['validfrom', 'effective', 'effectivedate', 'startdate', 'start', 'ratefrom', 'validityfrom'],
  validTo: ['validto', 'expiry', 'expirydate', 'expiration', 'enddate', 'end', 'rateto', 'validityto', 'validuntil', 'expires'],
  surcharges: ['surcharges', 'surcharge', 'notes', 'remarks', 'comments', 'comment', 'note'],
};

/**
 * Map one raw deposited row (arbitrary column names) to a canonical RateRow.
 * Origin + dest (the lane) are mandatory; a row without them returns null so
 * ingestion can report it as skipped rather than store a rate you can't match.
 */
export function normalizeRateRecord(
  raw: Record<string, string>,
  provenance: { sourceFile: string; sourceRef: string; ingestedAt: string },
): RateRow | null {
  const byNorm = new Map<string, string>();
  for (const [k, v] of Object.entries(raw)) {
    const nk = normKey(k);
    if (nk && !byNorm.has(nk)) byNorm.set(nk, (v ?? '').trim());
  }
  const pick = (col: keyof RateRow): string => {
    for (const syn of RATE_SYNONYMS[col] ?? []) {
      const val = byNorm.get(syn);
      if (val !== undefined && val !== '') return val;
    }
    return '';
  };
  const origin = pick('origin');
  const dest = pick('dest');
  if (!origin || !dest) return null;
  return {
    origin,
    dest,
    equipment: pick('equipment'),
    carrier: pick('carrier'),
    price: pick('price'),
    currency: pick('currency'),
    validFrom: pick('validFrom'),
    validTo: pick('validTo'),
    surcharges: pick('surcharges'),
    sourceFile: provenance.sourceFile,
    sourceRef: provenance.sourceRef,
    ingestedAt: provenance.ingestedAt,
  };
}

export interface AliasMap {
  port: Map<string, string>;
  carrier: Map<string, string>;
  equipment: Map<string, string>;
}

/** Load a `type,alias,canonical` synonym table (port/carrier/equipment). Missing file → empty map. */
export function loadAliases(path: string): AliasMap {
  const m: AliasMap = { port: new Map(), carrier: new Map(), equipment: new Map() };
  if (!existsSync(path)) return m;
  for (const o of csvToObjects(readFileSync(path, 'utf8'))) {
    const type = normKey(o.type ?? o.kind ?? '');
    const alias = normKey(o.alias ?? o.from ?? o.name ?? '');
    const canonical = (o.canonical ?? o.to ?? o.code ?? '').trim();
    if (!alias || !canonical) continue;
    if (type.startsWith('port') || type.startsWith('locode')) m.port.set(alias, canonical);
    else if (type.startsWith('carrier') || type.startsWith('line') || type.startsWith('scac')) m.carrier.set(alias, canonical);
    else if (type.startsWith('equip') || type.startsWith('container')) m.equipment.set(alias, canonical);
  }
  return m;
}

function canonValue(v: string, kind: keyof AliasMap, aliases: AliasMap): string {
  if (!v) return '';
  const mapped = aliases[kind].get(normKey(v));
  const base = mapped ?? v;
  return kind === 'equipment'
    ? base.toUpperCase().replace(/[^A-Z0-9]/g, '')
    : base.toUpperCase().replace(/\s+/g, '');
}

function parseDate(s: string): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function withinValidity(date: string, from: string, to: string): boolean {
  const d = parseDate(date);
  if (d === null) return true; // unparseable query date → don't exclude on it
  const f = parseDate(from);
  const t = parseDate(to);
  if (f !== null && d < f) return false;
  if (t !== null && d > t) return false;
  return true;
}

function priceNum(s: string): number {
  const n = parseFloat((s ?? '').replace(/[^0-9.]/g, ''));
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
}

export interface RateQuery {
  origin: string;
  dest: string;
  equipment?: string;
  carrier?: string;
  date?: string;
}

export interface RateMatch {
  confidence: 'exact' | 'partial' | 'none';
  best: RateRow | null;
  candidates: RateRow[];
  reasons: string[];
  query: RateQuery;
}

/**
 * Structured lane lookup — the retrieval half of the rate-book. Lane
 * (origin+dest) is required; equipment/carrier/date narrow it when supplied.
 * Among matches the cheapest priced row wins. Confidence is `exact` when the
 * lane plus every *supplied* dimension matched (with equipment given), else
 * `partial`; `none` when the lane isn't on file at all.
 */
export function matchRates(rows: RateRow[], q: RateQuery, aliases: AliasMap): RateMatch {
  const qo = canonValue(q.origin, 'port', aliases);
  const qd = canonValue(q.dest, 'port', aliases);
  const qe = q.equipment ? canonValue(q.equipment, 'equipment', aliases) : '';
  const qc = q.carrier ? canonValue(q.carrier, 'carrier', aliases) : '';

  let laneMatched = false;
  let equipMatched = false;
  let dateMatched = false;
  let carrierMatched = false;

  const candidates = rows.filter((r) => {
    if (canonValue(r.origin, 'port', aliases) !== qo) return false;
    if (canonValue(r.dest, 'port', aliases) !== qd) return false;
    laneMatched = true;
    if (qe && canonValue(r.equipment, 'equipment', aliases) !== qe) return false;
    if (qe) equipMatched = true;
    if (qc && canonValue(r.carrier, 'carrier', aliases) !== qc) return false;
    if (qc) carrierMatched = true;
    if (q.date && (r.validFrom || r.validTo)) {
      if (!withinValidity(q.date, r.validFrom, r.validTo)) return false;
      dateMatched = true;
    }
    return true;
  });

  if (candidates.length === 0) {
    return {
      confidence: laneMatched ? 'partial' : 'none',
      best: null,
      candidates: [],
      reasons: [
        laneMatched
          ? `lane ${qo}→${qd} exists but no row met the equipment/carrier/date filters`
          : `no rate on file for lane ${qo}→${qd}`,
      ],
      query: q,
    };
  }

  const sorted = [...candidates].sort((a, b) => priceNum(a.price) - priceNum(b.price));
  const reasons = [`lane ${qo}→${qd} matched`];
  if (qe) reasons.push(`equipment ${qe} matched`);
  if (qc) reasons.push(`carrier ${qc} matched`);
  if (q.date) reasons.push(dateMatched ? `date ${q.date} within validity` : `date not enforced (rows carry no validity)`);

  const confidence: RateMatch['confidence'] =
    q.equipment && equipMatched && (!q.date || dateMatched) ? 'exact' : 'partial';

  return { confidence, best: sorted[0], candidates: sorted, reasons, query: q };
}

// ---------------------------------------------------------------------------
// CLI argument parsing & output
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Tiny arg parser: `--key value`, `--flag`, and positionals. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export function flagString(flags: ParsedArgs['flags'], key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

/** Wrap a command's main(): load config, run, and print errors cleanly. */
export async function run(main: (config: Config) => Promise<void>): Promise<void> {
  try {
    await main(loadConfig());
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`\n✖ ${err.message}`);
    } else if (err instanceof Error) {
      console.error(`\n✖ ${err.message}`);
    } else {
      console.error('\n✖ Unexpected error:', err);
    }
    process.exit(1);
  }
}

export function heading(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
}

export function kv(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(16)} ${value}`);
}
