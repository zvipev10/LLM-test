import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dataDir = '/app/data';
const dbPath = path.join(dataDir, 'invoices.db');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db = new Database(dbPath);

db.pragma('foreign_keys = ON');

console.log(`📦 Database initialized at: ${dbPath}`);

function ensureColumn(tableName: string, columnName: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
  const exists = columns.some((column) => column.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

export function initializeDatabase() {
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

    CREATE TABLE IF NOT EXISTS gmail_staging (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gmailMessageId TEXT,
      threadId TEXT,
      fromAddress TEXT,
      subject TEXT,
      snippet TEXT,
      receivedAt TEXT,
      hasAttachments INTEGER,
      attachmentNames TEXT,
      category TEXT,
      isRelevant INTEGER,
      confidence TEXT,
      reason TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_gmail_message ON gmail_staging(gmailMessageId);
  `);

  ensureColumn('gmail_staging', 'gmailAttachmentId', 'TEXT');
  ensureColumn('gmail_staging', 'fileName', 'TEXT');
  ensureColumn('gmail_staging', 'mimeType', 'TEXT');
  ensureColumn('gmail_staging', 'sourceType', 'TEXT DEFAULT "attachment"');
}

export function resetDatabaseFile() {
  try {
    db.close();
  } catch (error) {
    console.warn('Could not close database before reset:', error);
  }

  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }

  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  initializeDatabase();

  console.log(`♻️ Database reset and recreated at: ${dbPath}`);
}

export default db;
