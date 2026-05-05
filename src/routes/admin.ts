import { Router } from 'express';

export const adminRouter = Router();

function getDb() {
  return require('../database/db').default;
}

adminRouter.get('/export-invoices', (_req, res) => {
  const db = getDb();
  const invoices = db.prepare('SELECT * FROM invoices ORDER BY id ASC').all();

  return res.status(200).json({
    success: true,
    exportedAt: new Date().toISOString(),
    count: invoices.length,
    invoices
  });
});
