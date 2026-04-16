import db from './db';
import { InvoiceData } from '../types/invoice';

export interface StoredInvoice extends InvoiceData {
  id?: number;
  fileName: string;
  vat?: number;
  status?: string;
  createdAt?: string;
}

export function saveInvoice(invoice: StoredInvoice): number {
  const stmt = db.prepare(`
    INSERT INTO invoices (
      fileName,
      vendorName,
      date,
      totalWithVat,
      totalWithoutVat,
      vat,
      currency,
      confidence,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    invoice.fileName,
    invoice.vendorName || null,
    invoice.date || null,
    invoice.totalWithVat || null,
    invoice.totalWithoutVat || null,
    invoice.vat || null,
    invoice.currency || 'ILS',
    invoice.confidence || null,
    'processed'
  );

  return result.lastInsertRowid as number;
}

export function saveBatch(invoices: StoredInvoice[]): number[] {
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
  let query = 'SELECT * FROM invoices WHERE 1=1';
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
