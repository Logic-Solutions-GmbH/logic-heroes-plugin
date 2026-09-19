import { readFileSync } from 'node:fs';

export interface PostgresClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string): Promise<{ rows: Record<string, unknown>[] } | { rows: Record<string, unknown>[] }[]>;
}

/** Execute local PostgreSQL operations with the result shape used by Supabase management queries. */
export class LocalPostgresSeam {
  constructor(private readonly client: PostgresClient) {}

  async applyMigrations(files: string[]): Promise<void> {
    for (const file of files) {
      await this.client.query('BEGIN');
      try {
        await this.client.query(readFileSync(file, 'utf8'));
        await this.client.query('COMMIT');
      } catch (error) {
        await this.client.query('ROLLBACK');
        throw error;
      }
    }
  }

  async runQuery(sql: string): Promise<Record<string, unknown>[]> {
    const result = await this.client.query(sql);
    if (Array.isArray(result)) return result.at(-1)?.rows ?? [];
    return result.rows;
  }
}
