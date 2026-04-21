import { InvoiceData } from '../types/invoice';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB in bytes

export interface StoredInvoice extends InvoiceData {
  id?: number;
  fileName: string;
  mimeType?: string;
  vat?: number;
  status?: string;
  createdAt?: string;
  printed?: string;
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

function normalizeComparableValue(value: any) {
  if (value === undefined || value === '') return null;
  return value;
}

export function saveInvoice(invoice: InvoiceWithFile, rowIndex?: number): number {
  const db = getDb();
  validateFileData(invoice, rowIndex);

  const columns = getInvoiceColumns();
  const hasVat = columns.has('vat');
  const hasConfidence = columns.has('confidence');
  const hasStatus = columns.has('status');
  const hasPrinted = columns.has('printed');

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
  if (hasPrinted) {
    insertColumns.push('printed');
    values.push(invoice.printed || 'לא');
  }

  const placeholders = insertColumns.map(() => '?').join(', ');
  const stmt = db.prepare(`INSERT INTO invoices (${insertColumns.join(', ')}) VALUES (${placeholders})`);
  const result = stmt.run(...values);
  return result.lastInsertRowid as number;
}

export function getInvoiceById(id: number): StoredInvoice | null {
  const db = getDb();
  const result = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as StoredInvoice | undefined;
  return result || null;
}

export function hasInvoiceChanges(invoice: InvoiceWithFile): boolean {
  if (!invoice.id) return true;

  const existing = getInvoiceById(invoice.id);
  if (!existing) return true;

  const comparisons: Array<[any, any]> = [
    [existing.fileName, invoice.fileName],
    [existing.mimeType, invoice.mimeType || null],
    [existing.vendorName, invoice.vendorName ?? null],
    [existing.date, invoice.date ?? null],
    [existing.totalWithVat, invoice.totalWithVat ?? null],
    [existing.totalWithoutVat, invoice.totalWithoutVat ?? null],
    [existing.currency, invoice.currency || 'ILS'],
    [existing.vat, invoice.vat ?? null],
    [existing.confidence, invoice.confidence || null],
    [existing.status, invoice.status || 'processed'],
    [existing.printed, invoice.printed || 'לא']
  ];

  return comparisons.some(([currentValue, incomingValue]) => {
    return normalizeComparableValue(currentValue) !== normalizeComparableValue(incomingValue);
  });
}

export function updateInvoice(invoice: InvoiceWithFile): boolean {
  if (!invoice.id) return false;

  const db = getDb();
  const columns = getInvoiceColumns();
  const assignments = [
    'fileName = ?',
    'mimeType = ?',
    'vendorName = ?',
    'date = ?',
    'totalWithVat = ?',
    'totalWithoutVat = ?',
    'currency = ?'
  ];
  const values: any[] = [
    invoice.fileName,
    invoice.mimeType || null,
    invoice.vendorName ?? null,
    invoice.date ?? null,
    invoice.totalWithVat ?? null,
    invoice.totalWithoutVat ?? null,
    invoice.currency || 'ILS'
  ];

  if (invoice.fileData) {
    assignments.splice(2, 0, 'fileData = ?');
    values.splice(2, 0, invoice.fileData);
  }
  if (columns.has('vat')) {
    assignments.push('vat = ?');
    values.push(invoice.vat ?? null);
  }
  if (columns.has('confidence')) {
    assignments.push('confidence = ?');
    values.push(invoice.confidence || null);
  }
  if (columns.has('status')) {
    assignments.push('status = ?');
    values.push(invoice.status || 'processed');
  }
  if (columns.has('printed')) {
    assignments.push('printed = ?');
    values.push(invoice.printed || 'לא');
  }
  if (columns.has('updatedAt')) {
    assignments.push('updatedAt = CURRENT_TIMESTAMP');
  }

  values.push(invoice.id);
  const stmt = db.prepare(`UPDATE invoices SET ${assignments.join(', ')} WHERE id = ?`);
  const result = stmt.run(...values);
  return result.changes > 0;
}

export function deleteInvoice(id: number): boolean {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM invoices WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

export function saveBatch(invoices: InvoiceWithFile[]): number[] {
  return invoices.map((invoice, idx) => saveInvoice(invoice, idx));
}

export function syncInvoices(invoices: InvoiceWithFile[]): number[] {
  return invoices.map((invoice, idx) => {
    if (invoice.id) {
      updateInvoice(invoice);
      return invoice.id;
    }
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
