import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = path.join(process.cwd(), 'invoices.db');

// Create or access database
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Initialize schema
export function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fileName TEXT NOT NULL,
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
