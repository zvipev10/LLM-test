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

  const columns = getInvoiceColumns();
  const hasVat = columns.has('vat');
  const hasConfidence = columns.has('confidence');
  const hasStatus = columns.has('status');

  const insertColumns = [
    'fileName',
    'mimeType',
    'fileData',
    'vendorName',
    'date',
    'totalWithVat',
    'totalWithoutVat',
    'currency'
  ];
  const values = [
    invoice.fileName,
    invoice.mimeType || null,
    invoice.fileData || null,
    invoice.vendorName ?? null,
    invoice.date ?? null,
    invoice.totalWithVat ?? null,
    invoice.totalWithoutVat ?? null,
    invoice.currency || 'ILS'
  ];

  if (hasVat) {
    insertColumns.push('vat');
    values.push(invoice.vat ?? null);
  }
  if (hasConfidence) {
    insertColumns.push('confidence');
    values.push(invoice.confidence || null);
  }
  if (hasStatus) {
    insertColumns.push('status');
    values.push(invoice.status || 'processed');
  }

  const placeholders = insertColumns.map(() => '?').join(', ');
  const stmt = db.prepare(`INSERT INTO invoices (${insertColumns.join(', ')}) VALUES (${placeholders})`);
  const result = stmt.run(...values);
  return result.lastInsertRowid as number;
}

export function saveBatch(invoices: InvoiceWithFile[]): number[] {
  return invoices.map((invoice, idx) => saveInvoice(invoice, idx));
}

export function syncInvoices(invoices: InvoiceWithFile[]): number[] {
  return invoices.map((invoice, idx) => {
    if (invoice.id) return invoice.id;
    return saveInvoice(invoice, idx);
  });
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
