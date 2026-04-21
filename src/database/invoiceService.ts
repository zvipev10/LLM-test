import db from './db';
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
  fileData?: string; // Base64 encoded file data
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
  const columns = db.prepare('PRAGMA table_info(invoices)').all() as Array<{ name: string }>;
  return new Set(columns.map((col) => col.name));
}

export function saveInvoice(invoice: InvoiceWithFile, rowIndex?: number): number {
  validateFileData(invoice, rowIndex);

  if (invoice.fileData) {
    const fileSizeInBytes = Buffer.byteLength(invoice.fileData, 'utf8');
    console.log(`[DB] Saving invoice ${invoice.fileName} with fileData (${(fileSizeInBytes / 1024).toFixed(2)}KB)`);
  } else {
    console.log(`[DB] Saving invoice ${invoice.fileName} without fileData`);
  }

  const stmt = db.prepare(`
    INSERT INTO invoices (
      fileName,
      mimeType,
      fileData,
      vendorName,
      date,
      totalWithVat,
      totalWithoutVat,
      vat,
      currency,
      confidence,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    invoice.fileName,
    invoice.mimeType || null,
    invoice.fileData || null,
    invoice.vendorName ?? null,
    invoice.date ?? null,
    invoice.totalWithVat !== null && invoice.totalWithVat !== undefined ? invoice.totalWithVat : null,
    invoice.totalWithoutVat !== null && invoice.totalWithoutVat !== undefined ? invoice.totalWithoutVat : null,
    invoice.vat !== null && invoice.vat !== undefined ? invoice.vat : null,
    invoice.currency || 'ILS',
    invoice.confidence || null,
    'processed'
  );

  const insertedId = result.lastInsertRowid as number;
  console.log(`[DB] Inserted invoice with ID ${insertedId}`);

  return insertedId;
}

export function saveBatch(invoices: InvoiceWithFile[]): number[] {
  const ids: number[] = [];

  for (let idx = 0; idx < invoices.length; idx++) {
    const id = saveInvoice(invoices[idx], idx);
    ids.push(id);
  }

  return ids;
}

export function syncInvoices(invoices: InvoiceWithFile[]): number[] {
  const ids: number[] = [];

  invoices.forEach((invoice, idx) => {
    if (invoice.id) {
      const updated = updateInvoice(invoice.id, {
        vendorName: invoice.vendorName ?? null,
        date: invoice.date ?? null,
        totalWithVat: invoice.totalWithVat,
        totalWithoutVat: invoice.totalWithoutVat,
        vat: invoice.vat,
        confidence: invoice.confidence || null,
        status: invoice.status || 'processed'
      });

      if (updated) {
        ids.push(invoice.id);
      }
      return;
    }

    const newId = saveInvoice(invoice, idx);
    ids.push(newId);
  });

  return ids;
}

export function clearAllInvoices(): number {
  const stmt = db.prepare('DELETE FROM invoices');
  const result = stmt.run();
  return result.changes;
}

export function getInvoices(options?: {
  limit?: number;
  offset?: number;
  vendorName?: string;
  dateFrom?: string;
  dateTo?: string;
}): StoredInvoice[] {
  const columns = getInvoiceColumns();
  const hasCreatedAt = columns.has('createdAt');
  const hasVat = columns.has('vat');
  const hasConfidence = columns.has('confidence');
  const hasStatus = columns.has('status');

  const selectFields = [
    'id',
    'fileName',
    'mimeType',
    'vendorName',
    'date',
    'totalWithVat',
    'totalWithoutVat',
    hasVat ? 'vat' : 'NULL as vat',
    'currency',
    hasConfidence ? 'confidence' : 'NULL as confidence',
    hasStatus ? 'status' : 'NULL as status',
    hasCreatedAt ? 'createdAt' : 'NULL as createdAt'
  ];

  let query = `SELECT ${selectFields.join(', ')} FROM invoices WHERE 1=1`;
  const params: (string | number)[] = [];

  if (options?.vendorName) {
    query += ' AND vendorName LIKE ?';
    params.push(`%${options.vendorName}%`);
  }

  if (options?.dateFrom) {
    query += ' AND date >= ?';
    params.push(options.dateFrom);
  }

  if (options?.dateTo) {
    query += ' AND date <= ?';
    params.push(options.dateTo);
  }

  if (hasCreatedAt) {
    query += ' ORDER BY CASE WHEN date IS NULL OR date = "" THEN 1 ELSE 0 END, date ASC, createdAt ASC';
  } else {
    query += ' ORDER BY CASE WHEN date IS NULL OR date = "" THEN 1 ELSE 0 END, date ASC, id ASC';
  }

  if (options?.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }

  if (options?.offset) {
    query += ' OFFSET ?';
    params.push(options.offset);
  }

  const stmt = db.prepare(query);
  return stmt.all(...params) as StoredInvoice[];
}

export function getInvoiceById(id: number): StoredInvoice | undefined {
  const stmt = db.prepare('SELECT * FROM invoices WHERE id = ?');
  return stmt.get(id) as StoredInvoice | undefined;
}

export function getInvoiceFileData(id: number): { fileData: string; mimeType: string } | null {
  const stmt = db.prepare('SELECT fileData, mimeType FROM invoices WHERE id = ?');
  const result = stmt.get(id) as any;
  console.log(`[DB] getInvoiceFileData(${id}):`, { hasResult: !!result, hasFileData: !!result?.fileData, fileDataType: typeof result?.fileData });

  if (result && result.fileData) {
    let fileDataStr = result.fileData;
    if (Buffer.isBuffer(fileDataStr)) {
      fileDataStr = fileDataStr.toString('base64');
      console.log(`[DB] Converted Buffer to base64, length: ${fileDataStr.length}`);
    }
    return {
      fileData: fileDataStr,
      mimeType: result.mimeType || 'application/octet-stream'
    };
  }
  console.log(`[DB] No file data found for invoice ${id}`);
  return null;
}

export function updateInvoice(id: number, updates: Partial<StoredInvoice>): boolean {
  const columns = getInvoiceColumns();
  const allowedFields = ['vendorName', 'date', 'totalWithVat', 'totalWithoutVat'];
  if (columns.has('vat')) allowedFields.push('vat');
  if (columns.has('confidence')) allowedFields.push('confidence');
  if (columns.has('status')) allowedFields.push('status');

  const fields = Object.keys(updates).filter(key => allowedFields.includes(key));

  if (fields.length === 0) return false;

  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => updates[f as keyof StoredInvoice]);

  const timestampClause = columns.has('updatedAt') ? ', updatedAt = CURRENT_TIMESTAMP' : '';

  const stmt = db.prepare(`
    UPDATE invoices 
    SET ${setClause}${timestampClause}
    WHERE id = ?
  `);

  const result = stmt.run(...values, id);
  return result.changes > 0;
}

export function deleteInvoice(id: number): boolean {
  const stmt = db.prepare('DELETE FROM invoices WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

export function getInvoiceStats(): {
  total: number;
  totalRevenue: number;
  totalVat: number;
  avgConfidence: string;
} {
  const columns = getInvoiceColumns();
  const hasVat = columns.has('vat');
  const hasConfidence = columns.has('confidence');

  const vatExpr = hasVat ? 'SUM(vat) as totalVat' : '0 as totalVat';
  const confidenceExpr = hasConfidence
    ? `AVG(CASE confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) as avgConfidence`
    : '2 as avgConfidence';

  const stmt = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(totalWithVat) as totalRevenue,
      ${vatExpr},
      ${confidenceExpr}
    FROM invoices
  `);

  const result = stmt.get() as any;
  return {
    total: result.total || 0,
    totalRevenue: result.totalRevenue || 0,
    totalVat: result.totalVat || 0,
    avgConfidence: result.avgConfidence > 2.5 ? 'high' : result.avgConfidence > 1.5 ? 'medium' : 'low'
  };
}
