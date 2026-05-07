import { InvoiceData } from '../types/invoice';
import { execute, query } from './db';
import { logger } from '../logger';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB in bytes

export interface StoredInvoice extends InvoiceData {
  id?: number;
  fileName: string;
  mimeType?: string;
  vat?: number;
  originalTotalWithVat?: number | null;
  status?: string;
  createdAt?: string;
  printed?: string;
  morningExpenseId?: string | null;
  morningSyncStatus?: string | null;
  morningSyncedAt?: string | null;
  morningSyncError?: string | null;
  morningFileSyncStatus?: string | null;
  morningFileSyncedAt?: string | null;
  morningFileSyncError?: string | null;
  morningCategoryId?: string | null;
  morningCategoryName?: string | null;
  morningCategoryCode?: number | null;
}

export interface InvoiceWithFile extends StoredInvoice {
  fileData?: string;
}

const INVOICE_COLUMNS = [
  'id',
  'fileName',
  'mimeType',
  'fileData',
  'vendorName',
  'date',
  'totalWithVat',
  'originalTotalWithVat',
  'totalWithoutVat',
  'vat',
  'currency',
  'confidence',
  'status',
  'printed',
  'morningExpenseId',
  'morningSyncStatus',
  'morningSyncedAt',
  'morningSyncError',
  'morningFileSyncStatus',
  'morningFileSyncedAt',
  'morningFileSyncError',
  'morningCategoryId',
  'morningCategoryName',
  'morningCategoryCode',
  'createdAt',
  'updatedAt'
] as const;

const DEFAULT_PRINTED = 'לא';

function quoteIdentifier(name: string) {
  return `"${name.replace(/"/g, '""')}"`;
}

function placeholders(count: number, startAt = 1) {
  return Array.from({ length: count }, (_value, index) => `$${index + startAt}`).join(', ');
}

function validateFileData(invoice: InvoiceWithFile, rowIndex?: number) {
  if (!invoice.fileData) return;

  const fileSizeInBytes = Buffer.byteLength(invoice.fileData, 'utf8');
  if (fileSizeInBytes > MAX_FILE_SIZE) {
    const rowInfo = rowIndex !== undefined ? ` (Row ${rowIndex + 1})` : '';
    throw new Error(`File size exceeds 10MB limit${rowInfo}. File: ${invoice.fileName}. Current size: ${(fileSizeInBytes / 1024 / 1024).toFixed(2)}MB`);
  }
}

function normalizeComparableValue(value: any) {
  if (value === undefined || value === '') return null;
  return value;
}

export function normalizeInvoiceStatus(status?: string | null) {
  if (status === 'pending' || status === 'approved') return status;
  return 'approved';
}

export async function saveInvoice(invoice: InvoiceWithFile, rowIndex?: number): Promise<number> {
  const startedAt = Date.now();
  validateFileData(invoice, rowIndex);

  const insertColumns = [
    'fileName',
    'mimeType',
    'fileData',
    'vendorName',
    'date',
    'totalWithVat',
    'originalTotalWithVat',
    'totalWithoutVat',
    'currency',
    'vat',
    'confidence',
    'status',
    'printed',
    'morningCategoryId',
    'morningCategoryName',
    'morningCategoryCode'
  ];
  const values = [
    invoice.fileName,
    invoice.mimeType || null,
    invoice.fileData || null,
    invoice.vendorName ?? null,
    invoice.date ?? null,
    invoice.totalWithVat ?? null,
    invoice.originalTotalWithVat ?? invoice.totalWithVat ?? null,
    invoice.totalWithoutVat ?? null,
    invoice.currency || 'ILS',
    invoice.vat ?? null,
    invoice.confidence || null,
    invoice.status || 'pending',
    invoice.printed || DEFAULT_PRINTED,
    invoice.morningCategoryId ?? null,
    invoice.morningCategoryName ?? null,
    invoice.morningCategoryCode ?? null
  ];

  const rows = await query<{ id: number }>(
    `INSERT INTO invoices (${insertColumns.map(quoteIdentifier).join(', ')})
     VALUES (${placeholders(values.length)})
     RETURNING id`,
    values
  );
  const id = rows[0].id;
  logger.info({
    invoiceId: id,
    rowIndex,
    hasFileData: Boolean(invoice.fileData),
    durationMs: Date.now() - startedAt
  }, 'invoice inserted');
  return id;
}

export async function findDuplicateInvoice(date?: string | null, totalWithVat?: number | null): Promise<StoredInvoice | null> {
  if (!date || totalWithVat === null || totalWithVat === undefined) return null;

  const selectedColumns = INVOICE_COLUMNS
    .filter((column) => column !== 'fileData')
    .map(quoteIdentifier)
    .join(', ');

  const rows = await query<StoredInvoice>(
    `SELECT ${selectedColumns}
     FROM invoices
     WHERE date = $1
       AND ROUND("totalWithVat"::numeric, 2) = ROUND($2::numeric, 2)
     ORDER BY "createdAt" ASC
     LIMIT 1`,
    [date, totalWithVat]
  );

  return rows[0] || null;
}

export async function getInvoiceById(id: number): Promise<StoredInvoice | null> {
  const startedAt = Date.now();
  const rows = await query<StoredInvoice>('SELECT * FROM invoices WHERE id = $1', [id]);
  const result = rows[0];
  logger.info({
    invoiceId: id,
    found: Boolean(result),
    durationMs: Date.now() - startedAt
  }, 'invoice fetched by id');
  return result || null;
}

export async function hasInvoiceChanges(invoice: InvoiceWithFile): Promise<boolean> {
  const startedAt = Date.now();
  if (!invoice.id) return true;

  const existing = await getInvoiceById(invoice.id);
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
    [existing.originalTotalWithVat, invoice.originalTotalWithVat ?? invoice.totalWithVat ?? null],
    [existing.totalWithoutVat, invoice.totalWithoutVat ?? null],
    [existing.currency, invoice.currency || 'ILS'],
    [existing.vat, invoice.vat ?? null],
    [existing.confidence, invoice.confidence || null],
    [existing.status, normalizeInvoiceStatus(invoice.status)],
    [existing.printed, invoice.printed || DEFAULT_PRINTED],
    [existing.morningCategoryId, invoice.morningCategoryId ?? null],
    [existing.morningCategoryName, invoice.morningCategoryName ?? null],
    [existing.morningCategoryCode, invoice.morningCategoryCode ?? null]
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

export async function updateInvoice(invoice: InvoiceWithFile): Promise<boolean> {
  if (!invoice.id) return false;

  const startedAt = Date.now();
  const assignments = [
    'fileName',
    'mimeType',
    'vendorName',
    'date',
    'totalWithVat',
    'originalTotalWithVat',
    'totalWithoutVat',
    'currency',
    'vat',
    'confidence',
    'status',
    'printed',
    'morningCategoryId',
    'morningCategoryName',
    'morningCategoryCode'
  ];
  const values: any[] = [
    invoice.fileName,
    invoice.mimeType || null,
    invoice.vendorName ?? null,
    invoice.date ?? null,
    invoice.totalWithVat ?? null,
    invoice.originalTotalWithVat ?? invoice.totalWithVat ?? null,
    invoice.totalWithoutVat ?? null,
    invoice.currency || 'ILS',
    invoice.vat ?? null,
    invoice.confidence || null,
    normalizeInvoiceStatus(invoice.status),
    invoice.printed || DEFAULT_PRINTED,
    invoice.morningCategoryId ?? null,
    invoice.morningCategoryName ?? null,
    invoice.morningCategoryCode ?? null
  ];

  if (invoice.fileData) {
    assignments.splice(2, 0, 'fileData');
    values.splice(2, 0, invoice.fileData);
  }

  const setClause = assignments
    .map((column, index) => `${quoteIdentifier(column)} = $${index + 1}`)
    .concat('"updatedAt" = CURRENT_TIMESTAMP')
    .join(', ');

  values.push(invoice.id);
  const result = await execute(`UPDATE invoices SET ${setClause} WHERE id = $${values.length}`, values);
  const updated = (result.rowCount ?? 0) > 0;
  logger.info({
    invoiceId: invoice.id,
    updated,
    changes: result.rowCount,
    hasFileData: Boolean(invoice.fileData),
    durationMs: Date.now() - startedAt
  }, 'invoice updated');
  return updated;
}

export async function updateInvoiceFields(id: number, fields: Partial<InvoiceWithFile>): Promise<boolean> {
  if (!id) return false;

  const allowedFields = [
    'vendorName',
    'date',
    'totalWithVat',
    'originalTotalWithVat',
    'totalWithoutVat',
    'currency',
    'vat',
    'confidence',
    'status',
    'printed',
    'morningCategoryId',
    'morningCategoryName',
    'morningCategoryCode'
  ] as const;

  const assignments: string[] = [];
  const values: any[] = [];

  for (const field of allowedFields) {
    if (!Object.prototype.hasOwnProperty.call(fields, field)) continue;

    let value = (fields as any)[field];
    if (field === 'status') value = normalizeInvoiceStatus(value);
    if (field === 'currency') value = value || 'ILS';
    if (field === 'printed') value = value || DEFAULT_PRINTED;

    assignments.push(`${quoteIdentifier(field)} = $${values.length + 1}`);
    values.push(value ?? null);
  }

  if (assignments.length === 0) return true;

  assignments.push('"updatedAt" = CURRENT_TIMESTAMP');
  values.push(id);

  const startedAt = Date.now();
  const result = await execute(
    `UPDATE invoices SET ${assignments.join(', ')} WHERE id = $${values.length}`,
    values
  );
  const updated = (result.rowCount ?? 0) > 0;
  logger.info({
    invoiceId: id,
    updated,
    fields: Object.keys(fields),
    durationMs: Date.now() - startedAt
  }, 'invoice fields updated');
  return updated;
}

export async function updateInvoiceMorningCategory(
  id: number,
  category: {
    morningCategoryId: string | null;
    morningCategoryName: string | null;
    morningCategoryCode: number | null;
  }
): Promise<boolean> {
  const startedAt = Date.now();
  const result = await execute(
    `UPDATE invoices
     SET "morningCategoryId" = $1,
         "morningCategoryName" = $2,
         "morningCategoryCode" = $3,
         "updatedAt" = CURRENT_TIMESTAMP
     WHERE id = $4`,
    [
      category.morningCategoryId,
      category.morningCategoryName,
      category.morningCategoryCode,
      id
    ]
  );
  const updated = (result.rowCount ?? 0) > 0;
  logger.info({
    invoiceId: id,
    updated,
    morningCategoryId: category.morningCategoryId,
    morningCategoryCode: category.morningCategoryCode,
    durationMs: Date.now() - startedAt
  }, 'invoice morning category updated');
  return updated;
}

export async function deleteInvoice(id: number): Promise<boolean> {
  const startedAt = Date.now();
  const result = await execute('DELETE FROM invoices WHERE id = $1', [id]);
  const deleted = (result.rowCount ?? 0) > 0;
  logger.info({
    invoiceId: id,
    deleted,
    changes: result.rowCount,
    durationMs: Date.now() - startedAt
  }, 'invoice deleted');
  return deleted;
}

export async function approveInvoices(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;

  const startedAt = Date.now();
  const values = [...ids];
  const result = await execute(
    `UPDATE invoices
     SET status = 'approved',
         "updatedAt" = CURRENT_TIMESTAMP
     WHERE id IN (${placeholders(values.length)})`,
    values
  );
  const approvedCount = result.rowCount ?? 0;
  logger.info({
    requestedCount: ids.length,
    approvedCount,
    durationMs: Date.now() - startedAt
  }, 'invoices approved');
  return approvedCount;
}

export async function getInvoices(status?: 'pending' | 'approved'): Promise<StoredInvoice[]> {
  const startedAt = Date.now();
  const selectedColumns = INVOICE_COLUMNS
    .filter((column) => column !== 'fileData')
    .map(quoteIdentifier)
    .join(', ');

  const whereClause = status ? ' WHERE status = $1' : '';
  const values = status ? [status] : [];
  const invoices = await query<StoredInvoice>(
    `SELECT ${selectedColumns} FROM invoices${whereClause} ORDER BY date ASC NULLS LAST, "createdAt" ASC`,
    values
  );
  logger.info({
    status: status || 'all',
    count: invoices.length,
    durationMs: Date.now() - startedAt
  }, 'invoices fetched');
  return invoices;
}

export async function getInvoiceFileData(id: number) {
  const rows = await query<{ fileData?: string; mimeType?: string | null }>(
    'SELECT "fileData", "mimeType" FROM invoices WHERE id = $1',
    [id]
  );
  return rows[0];
}

export async function updateMorningSyncStatus(
  id: number,
  status: 'sent' | 'failed',
  expenseId: string | null,
  error: string | null
): Promise<boolean> {
  const startedAt = Date.now();
  const result = await execute(
    `UPDATE invoices
     SET "morningExpenseId" = $1,
         "morningSyncStatus" = $2,
         "morningSyncedAt" = CURRENT_TIMESTAMP,
         "morningSyncError" = $3
     WHERE id = $4`,
    [expenseId, status, error, id]
  );
  const updated = (result.rowCount ?? 0) > 0;
  logger.info({
    invoiceId: id,
    status,
    updated,
    durationMs: Date.now() - startedAt
  }, 'invoice morning sync status updated');
  return updated;
}

export async function updateMorningFileSyncStatus(
  id: number,
  status: 'uploaded' | 'failed',
  error: string | null
): Promise<boolean> {
  const startedAt = Date.now();
  const result = await execute(
    `UPDATE invoices
     SET "morningFileSyncStatus" = $1,
         "morningFileSyncedAt" = CURRENT_TIMESTAMP,
         "morningFileSyncError" = $2
     WHERE id = $3`,
    [status, error, id]
  );
  const updated = (result.rowCount ?? 0) > 0;
  logger.info({
    invoiceId: id,
    status,
    updated,
    durationMs: Date.now() - startedAt
  }, 'invoice morning file sync status updated');
  return updated;
}
