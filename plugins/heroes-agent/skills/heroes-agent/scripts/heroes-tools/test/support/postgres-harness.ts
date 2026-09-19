import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { PostgresClient } from '../../local-postgres-seam';

export interface PostgresHarness {
  adminClient: PostgresClient;
  client: PostgresClient;
  databaseDir: string;
  port: number;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('PostgreSQL test port was not allocated.');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

export async function isTcpPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(200, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** Start one isolated PostgreSQL 17 cluster and create the plain-PostgreSQL Supabase roles. */
export async function startPostgresHarness(): Promise<PostgresHarness> {
  const databaseDir = await mkdtemp(join(tmpdir(), 'heroes-postgres-'));
  const port = await freePort();
  const postgres = new EmbeddedPostgres({
    databaseDir,
    port,
    user: 'heroes_postgres_admin',
    password: 'heroes_postgres_admin',
    persistent: true,
    onLog: () => {},
    onError: () => {},
  });
  let adminClient: PostgresClient | undefined;
  let client: PostgresClient | undefined;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (client) await client.end().catch(() => {});
    if (adminClient) await adminClient.end().catch(() => {});
    await postgres.stop().catch(() => {});
    await rm(databaseDir, { recursive: true, force: true });
    if (await isTcpPortOpen(port)) throw new Error(`PostgreSQL test process still listens on port ${port}.`);
  };

  try {
    await postgres.initialise();
    await postgres.start();
    adminClient = postgres.getPgClient() as unknown as PostgresClient;
    await adminClient.connect();
    await adminClient.query(`
      DO $roles$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'postgres') THEN
          CREATE ROLE postgres LOGIN CREATEROLE NOSUPERUSER PASSWORD 'postgres';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN;
        END IF;
      END
      $roles$;
      GRANT CREATE ON DATABASE postgres TO postgres;
    `);
    const migrationPostgres = new EmbeddedPostgres({
      databaseDir,
      port,
      user: 'postgres',
      password: 'postgres',
      persistent: true,
      onLog: () => {},
      onError: () => {},
    });
    client = migrationPostgres.getPgClient() as unknown as PostgresClient;
    await client.connect();
    return { adminClient, client, databaseDir, port, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
