import { Router } from 'express';

export const adminRouter = Router();

function getDb() {
  return require('../database/db').default;
}

function parsePositiveInteger(value: unknown, fallback: number, max?: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

adminRouter.get('/export-invoices', (req, res) => {
  const db = getDb();
  const limit = parsePositiveInteger(req.query.limit, 5, 25);
  const offset = parsePositiveInteger(req.query.offset, 0);
  const totalCount = (db.prepare('SELECT COUNT(*) as count FROM invoices').get() as { count: number }).count;
  const invoices = db.prepare('SELECT * FROM invoices ORDER BY id ASC LIMIT ? OFFSET ?').all(limit, offset);

  return res.status(200).json({
    success: true,
    exportedAt: new Date().toISOString(),
    count: invoices.length,
    totalCount,
    limit,
    offset,
    hasMore: offset + invoices.length < totalCount,
    invoices
  });
});
