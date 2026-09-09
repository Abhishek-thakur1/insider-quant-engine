import { Pool } from 'pg';

export const pool = new Pool({
  host: process.env.DB_HOST || 'quant_postgres', // default docker container name
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'insider_quant',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('[Postgres] Unexpected error on idle client', err);
});
