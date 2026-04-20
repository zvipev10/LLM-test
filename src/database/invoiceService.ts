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
  const sync = db.transaction((incomingInvoices: InvoiceWithFile[]) => {
    const ids: number[] = [];
    const incomingExistingIds = new Set<number>();

    const selectExistingStmt = db.prepare('SELECT id, fileData, mimeType FROM invoices WHERE id = ?');
    const updateStmt = db.prepare(`
      UPDATE invoices
      SET
        fileName = ?,
        mimeType = ?,
        fileData = ?,
        vendorName = ?,
        date = ?,
        totalWithVat = ?,
        totalWithoutVat = ?,
        vat = ?,
        currency = ?,
        confidence = ?,
        status = ?,
        updatedAt = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    const selectAllIdsStmt = db.prepare('SELECT id FROM invoices');
    const deleteStmt = db.prepare('DELETE FROM invoices WHERE id = ?');

    incomingInvoices.forEach((invoice, idx) => {
      validateFileData(invoice, idx);

      if (invoice.id) {
        const existing = selectExistingStmt.get(invoice.id) as { id: number; fileData: string | Buffer | null; mimeType: string | null } | undefined;

        if (!existing) {
          throw new Error(`Invoice with ID ${invoice.id} does not exist`);
        }

        const resolvedFileData = invoice.fileData ?? existing.fileData ?? null;
        const resolvedMimeType = invoice.mimeType ?? existing.mimeType ?? null;

        updateStmt.run(
          invoice.fileName,
          resolvedMimeType,
          resolvedFileData,
          invoice.vendorName ?? null,
          invoice.date ?? null,
          invoice.totalWithVat !== null && invoice.totalWithVat !== undefined ? invoice.totalWithVat : null,
          invoice.totalWithoutVat !== null && invoice.totalWithoutVat !== undefined ? invoice.totalWithoutVat : null,
          invoice.vat !== null && invoice.vat !== undefined ? invoice.vat : null,
          invoice.currency || 'ILS',
          invoice.confidence || null,
          invoice.status || 'processed',
          invoice.id
        );

        incomingExistingIds.add(invoice.id);
        ids.push(invoice.id);
        return;
      }

      const newId = saveInvoice(invoice, idx);
      ids.push(newId);
    });

    const existingRows = selectAllIdsStmt.all() as { id: number }[];
    existingRows.forEach(({ id }) => {
      if (!incomingExistingIds.has(id) && !ids.includes(id)) {
        deleteStmt.run(id);
      }
    });

    return ids;
  });

  return sync(invoices);
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
  let query = 'SELECT id, fileName, mimeType, vendorName, date, totalWithVat, totalWithoutVat, vat, currency, confidence, status, createdAt FROM invoices WHERE 1=1';
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

  query += ' ORDER BY CASE WHEN date IS NULL OR date = "" THEN 1 ELSE 0 END, date ASC, createdAt ASC';

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
  const allowedFields = ['vendorName', 'date', 'totalWithVat', 'totalWithoutVat', 'vat', 'confidence', 'status'];
  const fields = Object.keys(updates).filter(key => allowedFields.includes(key));

  if (fields.length === 0) return false;

  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => updates[f as keyof StoredInvoice]);

  const stmt = db.prepare(`
    UPDATE invoices 
    SET ${setClause}, updatedAt = CURRENT_TIMESTAMP 
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
  const stmt = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(totalWithVat) as totalRevenue,
      SUM(vat) as totalVat,
      AVG(CASE confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) as avgConfidence
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
