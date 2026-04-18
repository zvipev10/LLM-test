import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dataDir = '/app/data';
const dbPath = path.join(dataDir, 'invoices.db');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

db.pragma('foreign_keys = ON');

console.log(`📦 Database initialized at: ${dbPath}`);

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
}

export default db;
