import { Router, Request, Response } from 'express';
import { upload } from '../middleware/upload';
import { processInvoiceFile } from '../services/processInvoiceFile';
import { ErrorResponse } from '../types/invoice';
import { getInvoices, getInvoiceById, getInvoiceFileData, saveInvoice, updateInvoice, deleteInvoice, hasInvoiceChanges, updateMorningSyncStatus, updateMorningFileSyncStatus, updateInvoiceMorningCategory } from '../database/invoiceService';
import { logger } from '../logger';
import { getMorningAccountingClassificationOptions, sendInvoiceToMorning, uploadInvoiceFileToMorningExpense } from '../services/morningClient';
import { selectMorningCategoryForInvoice } from '../services/openai';
import type { MorningAccountingClassificationOption } from '../services/morningClient';

export const invoiceRouter = Router();

type MorningSyncResult = {
  invoiceId: number;
  success: boolean;
  skipped?: boolean;
  morningExpenseId?: string | null;
  morningFileSyncStatus?: 'uploaded' | 'failed' | 'missing' | null;
  morningFileSyncError?: string | null;
  error?: string;
};

type CategoryRefreshResult = {
  invoiceId: number;
  success: boolean;
  skipped?: boolean;
  oldCategoryId?: string | null;
  oldCategoryName?: string | null;
  oldCategoryCode?: number | null;
  morningCategoryId?: string | null;
  morningCategoryName?: string | null;
  morningCategoryCode?: number | null;
  changed?: boolean;
  error?: string;
};

function toStoredMorningCategory(category: MorningAccountingClassificationOption | null) {
  if (!category) {
    return {
      morningCategoryId: null,
      morningCategoryName: null,
      morningCategoryCode: null
    };
  }

  const numericCode = typeof category.code === 'number' ? category.code : Number(category.code);

  return {
    morningCategoryId: category.id,
    morningCategoryName: category.name,
    morningCategoryCode: Number.isFinite(numericCode) ? numericCode : null
  };
}

invoiceRouter.post(
  '/upload',
  upload.array('invoices', 20),
  async (req: Request, res: Response) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No files uploaded. Send files with field name "invoices"'
        } as ErrorResponse);
      }

      const files = req.files as Express.Multer.File[];

      const results = await Promise.all(
        files.map(async (file) => {
          try {
            const { buffer, mimetype, originalname } = file;
            return await processInvoiceFile(buffer, mimetype, originalname);
          } catch (err) {
            return {
              success: false,
              filename: file.originalname,
              error: err instanceof Error ? err.message : 'Failed to process file'
            };
          }
        })
      );

      return res.status(200).json({
        success: true,
        total: files.length,
        results
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      } as ErrorResponse);
    }
  }
);

invoiceRouter.post('/save-batch', async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const { invoices } = req.body;

    if (!Array.isArray(invoices)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid invoices data'
      });
    }

    const existingInvoices = await getInvoices();
    const existingIds = new Set(existingInvoices.map((inv: any) => inv.id));
    const incomingIds = new Set(invoices.filter((inv: any) => inv.id).map((inv: any) => inv.id));

    let deletedCount = 0;

    for (const id of existingIds) {
      if (!incomingIds.has(id)) {
        const deleted = await deleteInvoice(id);
        if (deleted) deletedCount += 1;
      }
    }

    const ids: number[] = [];
    let savedCount = 0;
    let updatedCount = 0;
    let insertedCount = 0;
    let unchangedCount = 0;

    for (const [idx, invoice] of invoices.entries()) {
      if (invoice.id) {
        const hasChanges = await hasInvoiceChanges(invoice);
        if (hasChanges) {
          const updated = await updateInvoice(invoice);
          if (updated) {
            ids.push(invoice.id);
            savedCount += 1;
            updatedCount += 1;
          }
        } else {
          unchangedCount += 1;
        }
      } else {
        const id = await saveInvoice(invoice, idx);
        ids.push(id);
        savedCount += 1;
        insertedCount += 1;
      }
    }

    logger.info({
      incomingCount: invoices.length,
      existingCount: existingInvoices.length,
      savedCount,
      insertedCount,
      updatedCount,
      unchangedCount,
      deletedCount,
      durationMs: Date.now() - startedAt
    }, 'invoice batch saved');

    return res.status(200).json({
      success: true,
      message: `Database synced: ${savedCount} saved/updated, ${deletedCount} deleted`,
      savedCount,
      deletedCount
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({
      error: errorMessage,
      durationMs: Date.now() - startedAt
    }, 'invoice batch save failed');
    return res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

invoiceRouter.get('/list', async (_req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const invoices = await getInvoices();
    logger.info({
      count: invoices.length,
      durationMs: Date.now() - startedAt
    }, 'invoices listed');
    return res.status(200).json({
      success: true,
      invoices
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      durationMs: Date.now() - startedAt
    }, 'invoice list failed');
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    });
  }
});

invoiceRouter.get('/morning/accounting-classifications', async (_req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const options = await getMorningAccountingClassificationOptions();

    logger.info({
      count: options.length,
      durationMs: Date.now() - startedAt
    }, 'morning accounting classifications listed');

    return res.status(200).json({
      success: true,
      count: options.length,
      options
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({
      error: errorMessage,
      durationMs: Date.now() - startedAt
    }, 'morning accounting classifications list failed');

    return res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

invoiceRouter.post('/morning/reclassify-categories', async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const { invoiceIds, onlyMissing = false, dryRun = false } = req.body || {};

    if (invoiceIds !== undefined && !Array.isArray(invoiceIds)) {
      return res.status(400).json({
        success: false,
        error: 'invoiceIds must be an array when provided'
      });
    }

    const requestedIds = Array.isArray(invoiceIds)
      ? new Set(
        invoiceIds
          .map((id: unknown) => Number(id))
          .filter((id: number) => Number.isInteger(id) && id > 0)
      )
      : null;

    if (Array.isArray(invoiceIds) && requestedIds?.size === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid invoice IDs were provided'
      });
    }

    const categories = await getMorningAccountingClassificationOptions(true);
    const invoices = (await getInvoices())
      .filter((invoice) => !requestedIds || requestedIds.has(Number(invoice.id)))
      .filter((invoice) => !onlyMissing || !invoice.morningCategoryId);

    const results: CategoryRefreshResult[] = [];

    for (const invoice of invoices) {
      if (!invoice.id) continue;

      try {
        const oldCategory = {
          oldCategoryId: invoice.morningCategoryId ?? null,
          oldCategoryName: invoice.morningCategoryName ?? null,
          oldCategoryCode: invoice.morningCategoryCode ?? null
        };
        const selected = await selectMorningCategoryForInvoice(invoice, categories);
        const nextCategory = toStoredMorningCategory(selected);
        const changed =
          (invoice.morningCategoryId ?? null) !== nextCategory.morningCategoryId ||
          (invoice.morningCategoryName ?? null) !== nextCategory.morningCategoryName ||
          (invoice.morningCategoryCode ?? null) !== nextCategory.morningCategoryCode;

        if (!dryRun && changed) {
          await updateInvoiceMorningCategory(invoice.id, nextCategory);
        }

        results.push({
          invoiceId: invoice.id,
          success: true,
          ...oldCategory,
          ...nextCategory,
          changed
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({
          invoiceId: invoice.id,
          error: errorMessage
        }, 'invoice morning category reclassification failed');
        results.push({
          invoiceId: invoice.id,
          success: false,
          error: errorMessage
        });
      }
    }

    const successCount = results.filter((result) => result.success).length;
    const changedCount = results.filter((result) => result.success && result.changed).length;

    logger.info({
      requestedCount: requestedIds?.size ?? null,
      processedCount: results.length,
      successCount,
      changedCount,
      failedCount: results.length - successCount,
      onlyMissing: Boolean(onlyMissing),
      dryRun: Boolean(dryRun),
      categoryCount: categories.length,
      durationMs: Date.now() - startedAt
    }, 'invoice morning categories reclassified');

    return res.status(200).json({
      success: true,
      processedCount: results.length,
      successCount,
      changedCount,
      failedCount: results.length - successCount,
      dryRun: Boolean(dryRun),
      results
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({
      error: errorMessage,
      durationMs: Date.now() - startedAt
    }, 'invoice morning categories reclassification batch failed');
    return res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

invoiceRouter.post('/send-to-morning', async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const { invoiceIds } = req.body;

    if (!Array.isArray(invoiceIds)) {
      return res.status(400).json({
        success: false,
        error: 'invoiceIds must be an array'
      });
    }

    const ids = invoiceIds
      .map((id: unknown) => Number(id))
      .filter((id: number) => Number.isInteger(id) && id > 0);

    if (ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid invoice IDs were provided'
      });
    }

    const results: MorningSyncResult[] = [];

    for (const id of ids) {
      const invoice = await getInvoiceById(id);

      if (!invoice) {
        results.push({ invoiceId: id, success: false, error: 'Invoice not found' });
        continue;
      }

      try {
        const existingExpenseId = invoice.morningSyncStatus === 'sent' ? invoice.morningExpenseId : null;
        const morningResult = existingExpenseId
          ? { expenseId: existingExpenseId, response: null }
          : await sendInvoiceToMorning(invoice);
        const expenseId = morningResult.expenseId;

        if (!expenseId) {
          throw new Error('Morning did not return an expense ID');
        }

        if (!existingExpenseId) {
          await updateMorningSyncStatus(id, 'sent', expenseId, null);
        }

        let morningFileSyncStatus: MorningSyncResult['morningFileSyncStatus'] = invoice.morningFileSyncStatus as MorningSyncResult['morningFileSyncStatus'] || null;
        let morningFileSyncError: string | null = null;

        if (invoice.morningFileSyncStatus !== 'uploaded') {
          const fileData = await getInvoiceFileData(id) as { fileData?: string; mimeType?: string | null } | undefined;

          if (fileData?.fileData) {
            try {
              await uploadInvoiceFileToMorningExpense({
                invoiceId: id,
                expenseId,
                fileName: invoice.fileName,
                mimeType: fileData.mimeType,
                fileBuffer: Buffer.from(fileData.fileData, 'base64')
              });
              await updateMorningFileSyncStatus(id, 'uploaded', null);
              morningFileSyncStatus = 'uploaded';
            } catch (fileError) {
              morningFileSyncError = fileError instanceof Error ? fileError.message : String(fileError);
              await updateMorningFileSyncStatus(id, 'failed', morningFileSyncError);
              morningFileSyncStatus = 'failed';
              logger.error({
                invoiceId: id,
                expenseId,
                error: morningFileSyncError
              }, 'invoice morning file sync failed');
            }
          } else {
            morningFileSyncStatus = 'missing';
            morningFileSyncError = 'No stored invoice file was found';
          }
        }

        results.push({
          invoiceId: id,
          success: true,
          skipped: Boolean(existingExpenseId),
          morningExpenseId: expenseId,
          morningFileSyncStatus,
          morningFileSyncError
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await updateMorningSyncStatus(id, 'failed', null, errorMessage);
        logger.error({
          invoiceId: id,
          error: errorMessage
        }, 'invoice morning sync failed');
        results.push({
          invoiceId: id,
          success: false,
          error: errorMessage
        });
      }
    }

    const successCount = results.filter((result) => result.success).length;
    const fileFailedCount = results.filter((result) => result.morningFileSyncStatus === 'failed').length;
    logger.info({
      requestedCount: ids.length,
      successCount,
      fileFailedCount,
      failedCount: results.length - successCount,
      durationMs: Date.now() - startedAt
    }, 'invoice morning batch completed');

    return res.status(200).json({
      success: true,
      successCount,
      failedCount: results.length - successCount,
      fileFailedCount,
      results
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({
      error: errorMessage,
      durationMs: Date.now() - startedAt
    }, 'invoice morning batch failed');
    return res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

invoiceRouter.get('/file/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const invoiceId = parseInt(id);

    if (isNaN(invoiceId)) {
      return res.status(400).json({ success: false, error: 'Invalid invoice ID' });
    }

    const fileData = await getInvoiceFileData(invoiceId) as any;

    if (!fileData || !fileData.fileData) {
      return res.status(404).json({ success: false, error: 'File not found or no file data stored' });
    }

    const buffer = Buffer.from(fileData.fileData, 'base64');
    res.set('Content-Type', fileData.mimeType || 'application/octet-stream');
    res.set('Content-Disposition', 'inline');
    res.send(buffer);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to retrieve file'
    });
  }
});

invoiceRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const invoices = await getInvoices();
    const stats = {
      total: invoices.length,
      totalRevenue: invoices.reduce((sum: number, inv: any) => sum + (inv.totalWithVat || 0), 0),
      totalVat: invoices.reduce((sum: number, inv: any) => sum + (inv.vat || 0), 0),
      avgConfidence: 'medium'
    };

    return res.status(200).json({
      success: true,
      stats
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to retrieve statistics'
    });
  }
});
