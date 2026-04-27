import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../logger';

const dataDir = '/app/data';
const dbPath = path.join(dataDir, 'invoices.db');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db = new Database(dbPath);

db.pragma('foreign_keys = ON');

logger.info({ dbPath }, 'database connection opened');

function ensureColumn(tableName: string, columnName: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
  const exists = columns.some((column) => column.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

export function initializeDatabase() {
  const startedAt = Date.now();
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fileName TEXT NOT NULL,
      mimeType TEXT,
      fileData BLOB,
      vendorName TEXT,
      date TEXT,
      totalWithVat REAL,
      totalWithoutVat REAL,
      vat REAL,
      currency TEXT DEFAULT 'ILS',
      confidence TEXT,
      status TEXT DEFAULT 'processed',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  ensureColumn('invoices', 'printed', "TEXT DEFAULT 'לא'");
  logger.info({
    dbPath,
    durationMs: Date.now() - startedAt
  }, 'database initialized');
}

export default db;
