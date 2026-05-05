import { Router } from 'express';
import { execute } from '../database/db';

export const adminRouter = Router();

const IMPORT_COLUMNS = [
  'id',
  'fileName',
  'mimeType',
  'fileData',
  'vendorName',
  'date',
  'totalWithVat',
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
];

function quoteIdentifier(name: string) {
  return `"${name.replace(/"/g, '""')}"`;
}

function normalizeDateTime(value: unknown) {
  if (!value) return null;
  return value;
}

function normalizeInvoice(invoice: any) {
  return {
    id: invoice.id == null ? null : Number(invoice.id),
    fileName: invoice.fileName,
    mimeType: invoice.mimeType ?? null,
    fileData: invoice.fileData ?? null,
    vendorName: invoice.vendorName ?? null,
    date: invoice.date ?? null,
    totalWithVat: invoice.totalWithVat ?? null,
    totalWithoutVat: invoice.totalWithoutVat ?? null,
    vat: invoice.vat ?? null,
    currency: invoice.currency || 'ILS',
    confidence: invoice.confidence ?? null,
    status: invoice.status || 'processed',
    printed: invoice.printed || '×œ×',
    morningExpenseId: invoice.morningExpenseId ?? null,
    morningSyncStatus: invoice.morningSyncStatus ?? null,
    morningSyncedAt: normalizeDateTime(invoice.morningSyncedAt),
    morningSyncError: invoice.morningSyncError ?? null,
    morningFileSyncStatus: invoice.morningFileSyncStatus ?? null,
    morningFileSyncedAt: normalizeDateTime(invoice.morningFileSyncedAt),
    morningFileSyncError: invoice.morningFileSyncError ?? null,
    morningCategoryId: invoice.morningCategoryId ?? null,
    morningCategoryName: invoice.morningCategoryName ?? null,
    morningCategoryCode: invoice.morningCategoryCode ?? null,
    createdAt: normalizeDateTime(invoice.createdAt),
    updatedAt: normalizeDateTime(invoice.updatedAt)
  };
}

adminRouter.post('/import-invoices', async (req, res) => {
  const invoices = req.body?.invoices;

  if (!Array.isArray(invoices)) {
    return res.status(400).json({
      success: false,
      error: 'Request body must include invoices array'
    });
  }

  let importedCount = 0;
  let skippedCount = 0;
  const results: Array<{ id: number | null; success: boolean; skipped?: boolean; error?: string }> = [];

  for (const rawInvoice of invoices) {
    const invoice = normalizeInvoice(rawInvoice);

    if (!invoice.id || !invoice.fileName) {
      skippedCount += 1;
      results.push({
        id: invoice.id,
        success: false,
        skipped: true,
        error: 'Missing id or fileName'
      });
      continue;
    }

    const values = IMPORT_COLUMNS.map((column) => (invoice as any)[column]);
    const placeholders = values.map((_value, index) => `$${index + 1}`).join(', ');
    const assignments = IMPORT_COLUMNS
      .filter((column) => column !== 'id')
      .map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)
      .join(', ');

    await execute(
      `INSERT INTO invoices (${IMPORT_COLUMNS.map(quoteIdentifier).join(', ')})
       VALUES (${placeholders})
       ON CONFLICT (id) DO UPDATE SET ${assignments}`,
      values
    );

    importedCount += 1;
    results.push({
      id: invoice.id,
      success: true
    });
  }

  await execute(`
    SELECT setval(
      pg_get_serial_sequence('invoices', 'id'),
      COALESCE((SELECT MAX(id) FROM invoices), 1),
      true
    )
  `);

  return res.status(200).json({
    success: true,
    importedCount,
    skippedCount,
    total: invoices.length,
    results
  });
});
