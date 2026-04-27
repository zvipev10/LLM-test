import { InvoiceData } from '../types/invoice';
import { logger } from '../logger';

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

function getInvoiceColumns(): Set<string> {
  const db = getDb();
  const columns = db.prepare('PRAGMA table_info(invoices)').all() as Array<{ name: string }>;
  return new Set(columns.map((col) => col.name));
}

function normalizeComparableValue(value: any) {
  if (value === undefined || value === '') return null;
  return value;
}

export function saveInvoice(invoice: InvoiceWithFile, rowIndex?: number): number {
  const startedAt = Date.now();
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
  const id = result.lastInsertRowid as number;
  logger.info({
    invoiceId: id,
    rowIndex,
    hasFileData: Boolean(invoice.fileData),
    durationMs: Date.now() - startedAt
  }, 'invoice inserted');
  return id;
}

export function getInvoiceById(id: number): StoredInvoice | null {
  const startedAt = Date.now();
  const db = getDb();
  const result = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as StoredInvoice | undefined;
  logger.info({
    invoiceId: id,
    found: Boolean(result),
    durationMs: Date.now() - startedAt
  }, 'invoice fetched by id');
  return result || null;
}

export function hasInvoiceChanges(invoice: InvoiceWithFile): boolean {
  const startedAt = Date.now();
  if (!invoice.id) return true;

  const existing = getInvoiceById(invoice.id);
  if (!existing) {
    logger.info({
      invoiceId: invoice.id,
      hasChanges: true,
      reason: 'missing existing invoice',
      durationMs: Date.now() - startedAt
    }, 'invoice change check completed');
    return true;
  }

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

  const hasChanges = comparisons.some(([currentValue, incomingValue]) => {
    return normalizeComparableValue(currentValue) !== normalizeComparableValue(incomingValue);
  });
  logger.info({
    invoiceId: invoice.id,
    hasChanges,
    durationMs: Date.now() - startedAt
  }, 'invoice change check completed');
  return hasChanges;
}

export function updateInvoice(invoice: InvoiceWithFile): boolean {
  if (!invoice.id) return false;

  const startedAt = Date.now();
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
  const updated = result.changes > 0;
  logger.info({
    invoiceId: invoice.id,
    updated,
    changes: result.changes,
    hasFileData: Boolean(invoice.fileData),
    durationMs: Date.now() - startedAt
  }, 'invoice updated');
  return updated;
}

export function deleteInvoice(id: number): boolean {
  const startedAt = Date.now();
  const db = getDb();
  const stmt = db.prepare('DELETE FROM invoices WHERE id = ?');
  const result = stmt.run(id);
  const deleted = result.changes > 0;
  logger.info({
    invoiceId: id,
    deleted,
    changes: result.changes,
    durationMs: Date.now() - startedAt
  }, 'invoice deleted');
  return deleted;
}

export function getInvoices(): StoredInvoice[] {
  const startedAt = Date.now();
  const db = getDb();
  const columns = getInvoiceColumns();
  const selectedColumns = Array.from(columns)
    .filter((column) => column !== 'fileData')
    .map((column) => `"${column.replace(/"/g, '""')}"`)
    .join(', ');

  const hasCreatedAt = columns.has('createdAt');

  const query = hasCreatedAt
    ? `SELECT ${selectedColumns} FROM invoices ORDER BY date ASC, createdAt ASC`
    : `SELECT ${selectedColumns} FROM invoices ORDER BY date ASC, id ASC`;

  const invoices = db.prepare(query).all();
  logger.info({
    count: invoices.length,
    durationMs: Date.now() - startedAt
  }, 'invoices fetched');
  return invoices;
}

export function getInvoiceFileData(id: number) {
  const db = getDb();
  return db.prepare('SELECT fileData, mimeType FROM invoices WHERE id = ?').get(id);
}
