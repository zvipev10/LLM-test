import { neon } from '@neondatabase/serverless';
import { logger } from '../logger';

type NeonQuery = ReturnType<typeof neon<false, true>>;

let sql: NeonQuery | null = null;
let initializePromise: Promise<void> | null = null;
const RETRYABLE_DB_ERROR_PATTERN = /fetch failed|Error connecting to database|ECONNRESET|ETIMEDOUT|terminated/i;

function getConnectionString() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

  if (!connectionString) {
    throw new Error('Missing DATABASE_URL or POSTGRES_URL for Neon Postgres connection');
  }

  return connectionString;
}

function getSql() {
  if (!sql) {
    sql = neon<false, true>(getConnectionString(), { fullResults: true });
    logger.info('neon http query client created');
  }

  return sql;
}

export async function initializeDatabase() {
  if (initializePromise) return initializePromise;

  initializePromise = (async () => {
    const startedAt = Date.now();

    await getSql().query(`
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
        printed TEXT DEFAULT 'לא',
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

    await getSql().query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        "updatedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await getSql().query(`
      UPDATE invoices
      SET printed = 'לא'
      WHERE printed IN ('×œ×', 'Ã—Å“Ã—Â');
    `);

    logger.info({
      durationMs: Date.now() - startedAt
    }, 'postgres database initialized');
  })();

  initializePromise.catch((err) => {
    initializePromise = null;
    logger.error({
      error: err instanceof Error ? err.message : String(err)
    }, 'postgres database initialization promise reset after failure');
  });

  return initializePromise;
}

async function runWithRetry<T>(operation: () => Promise<T>, context: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      const retryable = RETRYABLE_DB_ERROR_PATTERN.test(message);

      if (!retryable || attempt === 3) {
        throw err;
      }

      sql = null;
      initializePromise = null;

      logger.warn({
        context,
        attempt,
        error: message
      }, 'retrying transient postgres operation failure');

      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }

  throw lastError;
}

export async function query<T = any>(text: string, values: any[] = []): Promise<T[]> {
  return runWithRetry(async () => {
    await initializeDatabase();
    const result = await getSql().query(text, values);
    return result.rows as T[];
  }, 'query');
}

export async function execute(text: string, values: any[] = []) {
  return runWithRetry(async () => {
    await initializeDatabase();
    return getSql().query(text, values);
  }, 'execute');
}
