import { Pool } from '@neondatabase/serverless';
import { logger } from '../logger';

let pool: Pool | null = null;
let initializePromise: Promise<void> | null = null;

function getConnectionString() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

  if (!connectionString) {
    throw new Error('Missing DATABASE_URL or POSTGRES_URL for Neon Postgres connection');
  }

  return connectionString;
}

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: getConnectionString() });
    logger.info('postgres connection pool created');
  }

  return pool;
}

export async function initializeDatabase() {
  if (initializePromise) return initializePromise;

  initializePromise = (async () => {
    const startedAt = Date.now();

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        "fileName" TEXT NOT NULL,
        "mimeType" TEXT,
        "fileData" TEXT,
        "vendorName" TEXT,
        date TEXT,
        "totalWithVat" DOUBLE PRECISION,
        "totalWithoutVat" DOUBLE PRECISION,
        vat DOUBLE PRECISION,
        currency TEXT DEFAULT 'ILS',
        confidence TEXT,
        status TEXT DEFAULT 'processed',
        printed TEXT DEFAULT '×œ×',
        "morningExpenseId" TEXT,
        "morningSyncStatus" TEXT,
        "morningSyncedAt" TIMESTAMPTZ,
        "morningSyncError" TEXT,
        "morningFileSyncStatus" TEXT,
        "morningFileSyncedAt" TIMESTAMPTZ,
        "morningFileSyncError" TEXT,
        "morningCategoryId" TEXT,
        "morningCategoryName" TEXT,
        "morningCategoryCode" INTEGER,
        "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    logger.info({
      durationMs: Date.now() - startedAt
    }, 'postgres database initialized');
  })();

  return initializePromise;
}

export async function query<T = any>(text: string, values: any[] = []): Promise<T[]> {
  await initializeDatabase();
  const result = await getPool().query(text, values);
  return result.rows as T[];
}

export async function execute(text: string, values: any[] = []) {
  await initializeDatabase();
  return getPool().query(text, values);
}
