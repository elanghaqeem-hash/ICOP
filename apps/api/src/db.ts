import postgres from 'postgres';
import { config } from './config.js';

export type Sql = postgres.Sql<Record<string, unknown>>;
export type Tx = postgres.TransactionSql<Record<string, unknown>>;

export function createSql(url = config.databaseUrl): Sql {
  return postgres(url, {
    max: Number(process.env.DB_POOL_MAX ?? 10),
    // Hanya nama kolom yang dikonversi; isi JSONB dibiarkan apa adanya
    transform: { column: { from: postgres.toCamel, to: postgres.fromCamel } },
    onnotice: () => {},
    types: {
      // numeric → JS number (IDR values stay well below 2^53)
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (x: unknown) => String(x),
        parse: (x: string) => Number(x),
      },
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: unknown) => String(x),
        parse: (x: string) => Number(x),
      },
    },
  }) as unknown as Sql;
}
