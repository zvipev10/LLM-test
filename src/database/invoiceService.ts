import { InvoiceData } from '../types/invoice';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB in bytes

export interface StoredInvoice extends InvoiceData {
  id?: number;
  fileName: string;
  mimeType?: string;
  vat?: number;
  status?: string;
  createdAt?: string;
}

export interface InvoiceWithFile extends StoredInvoice {
  fileData?: string;
}

function getDb() {
  return require('./db').default;
}

function validateFileData(invoice: InvoiceWithFile, rowIndex?: number) {
  if (!invoice.fileData) return;

  const fileSizeInBytes = Buffer.byteLength(invoice.fileData, 'utf8');
  if (fileSizeInBytes > MAX_FILE_SIZE) {
    const rowInfo = rowIndex !== undefined ? ` (Row ${rowIndex + 1})` : '';
    throw new Error(`File size exceeds 10MB limit${rowInfo}. File: ${invoice.fileName}. Current size: ${(fileSizeInBytes / 1024 / 1024).toFixed(2)}MB`);
  }
}

function getInvoiceColumns() {
  const db = getDb();
  const columns = db.prepare('PRAGMA table_info(invoices)').all();
  return new Set(columns.map((col: any) => col.name));
}

export function saveInvoice(invoice: InvoiceWithFile, rowIndex?: number): number {
  const db = getDb();
  validateFileData(invoice, rowIndex);

  const stmt = db.prepare(`
    INSERT INTO invoices (
      fileName, mimeType, fileData, vendorName, date,
      totalWithVat, totalWithoutVat, vat, currency, confidence, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    invoice.fileName,
    invoice.mimeType || null,
    invoice.fileData || null,
    invoice.vendorName ?? null,
    invoice.date ?? null,
    invoice.totalWithVat ?? null,
    invoice.totalWithoutVat ?? null,
    invoice.vat ?? null,
    invoice.currency || 'ILS',
    invoice.confidence || null,
    'processed'
  );

  return result.lastInsertRowid as number;
}

export function getInvoices(): StoredInvoice[] {
  const db = getDb();
  const columns = getInvoiceColumns();

  const hasCreatedAt = columns.has('createdAt');

  const query = hasCreatedAt
    ? `SELECT * FROM invoices ORDER BY date ASC, createdAt ASC`
    : `SELECT * FROM invoices ORDER BY date ASC, id ASC`;

  return db.prepare(query).all();
}

export function clearAllInvoices(): number {
  const db = getDb();
  return db.prepare('DELETE FROM invoices').run().changes;
}

export function getInvoiceFileData(id: number) {
  const db = getDb();
  return db.prepare('SELECT fileData, mimeType FROM invoices WHERE id = ?').get(id);
}
