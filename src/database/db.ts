import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Use persistent volume path on Railway, fallback to current directory for local dev
const dataDir = '/app/data';
const dbPath = path.join(dataDir, 'invoices.db');

// Create data directory if it doesn't exist (for local development)
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Create or access database
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

console.log(`📦 Database initialized at: ${dbPath}`);

// Initialize schema
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

    CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(date);
    CREATE INDEX IF NOT EXISTS idx_invoices_vendor ON invoices(vendorName);
    CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices(createdAt);
  `);
}

export default db;
