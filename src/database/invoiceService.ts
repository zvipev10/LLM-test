import db from './db';
import { InvoiceData } from '../types/invoice';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB in bytes

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

export function saveInvoice(invoice: InvoiceWithFile): number {
  // Validate file size if fileData is provided
  if (invoice.fileData) {
    const fileSizeInBytes = Buffer.byteLength(invoice.fileData, 'utf8');
    if (fileSizeInBytes > MAX_FILE_SIZE) {
      throw new Error(`File size exceeds 2MB limit. Current size: ${(fileSizeInBytes / 1024 / 1024).toFixed(2)}MB`);
    }
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

  return result.lastInsertRowid as number;
}

export function saveBatch(invoices: InvoiceWithFile[]): number[] {
  const ids: number[] = [];
  
  for (const invoice of invoices) {
    const id = saveInvoice(invoice);
    ids.push(id);
  }
  
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

  query += ' ORDER BY createdAt DESC';

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
  if (result && result.fileData) {
    return {
      fileData: result.fileData,
      mimeType: result.mimeType || 'application/octet-stream'
    };
  }
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
