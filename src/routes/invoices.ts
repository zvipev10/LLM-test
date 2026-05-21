import { Router, Request, Response } from 'express';
import { del } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import { upload } from '../middleware/upload';
import { processInvoiceFile } from '../services/processInvoiceFile';
import { ErrorResponse } from '../types/invoice';
import { approveInvoices, findDuplicateInvoice, getInvoices, getInvoiceById, getInvoiceFileData, getInvoicesPage, saveInvoice, updateInvoiceFields, deleteInvoice, resetAllMorningSyncStatuses, updateMorningSyncStatus, updateMorningFileSyncStatus, updateInvoiceMorningCategory } from '../database/invoiceService';
import { logger } from '../logger';
import { getMorningAccountingClassificationOptions, sendInvoiceToMorning, updateInvoiceInMorning, uploadInvoiceFileToMorningExpense } from '../services/morningClient';
import { selectMorningCategoryForInvoice } from '../services/openai';
import type { MorningAccountingClassificationOption } from '../services/morningClient';

export const invoiceRouter = Router();

const BLOB_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED_INVOICE_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp'
];

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

type MorningEnvironmentMigrationResult = {
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

function sanitizeBlobPathSegment(value: string) {
  const sanitized = value
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return sanitized || 'invoice';
}

function inferInvoiceContentType(fileName: string, fallback?: string | null) {
  if (fallback && fallback !== 'application/octet-stream') return fallback;

  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith('.pdf')) return 'application/pdf';
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.webp')) return 'image/webp';
  return fallback || 'application/octet-stream';
}

async function saveProcessedInvoiceResult(processed: any, index = 0) {
  const { fileData, data, filename, mimeType, ...rest } = processed;
  const originalTotalWithVat = data.originalTotalWithVat ?? data.totalWithVat;
  const duplicate = await findDuplicateInvoice(data.date, originalTotalWithVat);

  if (duplicate) {
    logger.info({
      filename,
      duplicateInvoiceId: duplicate.id,
      date: data.date,
      originalTotalWithVat
    }, 'duplicate invoice skipped before insert');

    return {
      ...rest,
      success: false,
      duplicate: true,
      filename,
      mimeType,
      data,
      existingInvoice: duplicate,
      error: 'Duplicate invoice already exists'
    };
  }

  const id = await saveInvoice({
    fileName: filename,
    mimeType,
    fileData,
    vendorName: data.vendorName,
    date: data.date,
    totalWithVat: data.totalWithVat,
    originalTotalWithVat: data.originalTotalWithVat ?? data.totalWithVat,
    totalWithoutVat: data.totalWithoutVat,
    vat: data.totalWithVat != null && data.totalWithoutVat != null ? data.totalWithVat - data.totalWithoutVat : undefined,
    currency: data.currency || 'ILS',
    status: 'pending',
    morningCategoryId: data.morningCategoryId ?? null,
    morningCategoryName: data.morningCategoryName ?? null,
    morningCategoryCode: data.morningCategoryCode ?? null
  }, index);

  return {
    ...rest,
    success: true,
    id,
    filename,
    mimeType,
    data
  };
}

invoiceRouter.post('/blob-token', async (req: Request, res: Response) => {
  try {
    const { filename, contentType, size } = req.body || {};

    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ success: false, error: 'filename is required' });
    }

    const resolvedContentType = inferInvoiceContentType(filename, typeof contentType === 'string' ? contentType : null);
    if (!ALLOWED_INVOICE_CONTENT_TYPES.includes(resolvedContentType)) {
      return res.status(400).json({ success: false, error: 'Unsupported file type' });
    }

    if (Number(size) > BLOB_UPLOAD_MAX_BYTES) {
      return res.status(400).json({ success: false, error: 'Uploaded file is too large' });
    }

    const pathname = `invoice-uploads/${Date.now()}-${sanitizeBlobPathSegment(filename)}`;
    const token = await generateClientTokenFromReadWriteToken({
      pathname,
      addRandomSuffix: true,
      maximumSizeInBytes: BLOB_UPLOAD_MAX_BYTES,
      allowedContentTypes: ALLOWED_INVOICE_CONTENT_TYPES
    });

    return res.status(200).json({
      success: true,
      pathname,
      token
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage }, 'blob upload token generation failed');
    return res.status(500).json({ success: false, error: errorMessage });
  }
});

invoiceRouter.post('/process-blob', async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const { url, filename, mimeType } = req.body || {};

  try {
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'url is required' });
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download uploaded blob: ${response.status} ${response.statusText}`);
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > BLOB_UPLOAD_MAX_BYTES) {
      throw new Error('Uploaded file is too large');
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > BLOB_UPLOAD_MAX_BYTES) {
      throw new Error('Uploaded file is too large');
    }

    const resolvedFilename = typeof filename === 'string' && filename ? filename : 'invoice';
    const resolvedMimeType = inferInvoiceContentType(
      resolvedFilename,
      typeof mimeType === 'string' && mimeType ? mimeType : response.headers.get('content-type')
    );

    const processed = await processInvoiceFile(Buffer.from(arrayBuffer), resolvedMimeType, resolvedFilename);
    if (!processed.success) {
      return res.status(200).json({ success: true, result: processed });
    }

    const result = await saveProcessedInvoiceResult(processed);

    try {
      await del(url);
    } catch (cleanupError) {
      logger.warn({
        url,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }, 'uploaded blob cleanup failed');
    }

    logger.info({
      filename: resolvedFilename,
      bytes: arrayBuffer.byteLength,
      invoiceId: result.id,
      durationMs: Date.now() - startedAt
    }, 'blob invoice processed');

    return res.status(200).json({
      success: true,
      result
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({
      url,
      filename,
      error: errorMessage,
      durationMs: Date.now() - startedAt
    }, 'blob invoice processing failed');
    return res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

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
        files.map(async (file, index) => {
          try {
            const { buffer, mimetype, originalname } = file;
            const processed = await processInvoiceFile(buffer, mimetype, originalname);

            if (processed.success) {
              return saveProcessedInvoiceResult(processed, index);
            }

            return processed;
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

invoiceRouter.get('/list', async (_req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');

    const status = _req.query.status === 'pending' || _req.query.status === 'approved'
      ? _req.query.status
      : undefined;
    const page = typeof _req.query.page === 'string' ? Number(_req.query.page) : undefined;
    const pageSize = typeof _req.query.pageSize === 'string' ? Number(_req.query.pageSize) : undefined;
    const vendor = typeof _req.query.vendor === 'string' ? _req.query.vendor.trim() : undefined;
    const fromDate = typeof _req.query.fromDate === 'string' ? _req.query.fromDate : undefined;
    const toDate = typeof _req.query.toDate === 'string' ? _req.query.toDate : undefined;
    const usePagedList = Number.isFinite(page) || Number.isFinite(pageSize) || Boolean(vendor || fromDate || toDate);

    if (usePagedList) {
      const listPage = await getInvoicesPage({
        status,
        vendor,
        fromDate,
        toDate,
        page,
        pageSize
      });
      logger.info({
        status: status || 'all',
        count: listPage.invoices.length,
        totalCount: listPage.totalCount,
        page: listPage.page,
        pageSize: listPage.pageSize,
        durationMs: Date.now() - startedAt
      }, 'invoices listed');
      return res.status(200).json({
        success: true,
        invoices: listPage.invoices,
        page: listPage.page,
        pageSize: listPage.pageSize,
        totalCount: listPage.totalCount,
        unfilteredCount: listPage.unfilteredCount,
        totals: listPage.totals
      });
    }

    const invoices = await getInvoices(status);
    logger.info({
      status: status || 'all',
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

invoiceRouter.post('/approve', async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const invoiceIds = Array.isArray(req.body?.invoiceIds)
      ? req.body.invoiceIds
          .map((id: unknown) => Number(id))
          .filter((id: number) => Number.isInteger(id) && id > 0)
      : [];

    if (invoiceIds.length === 0) {
      return res.status(400).json({ success: false, error: 'invoiceIds must include at least one valid id' });
    }

    const approvedCount = await approveInvoices(invoiceIds);
    return res.status(200).json({
      success: true,
      approvedCount
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({
      error: errorMessage,
      durationMs: Date.now() - startedAt
    }, 'invoice approve failed');
    return res.status(500).json({ success: false, error: errorMessage });
  }
});

invoiceRouter.patch('/:id', async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Valid invoice id is required' });
    }

    const updated = await updateInvoiceFields(id, req.body || {});
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }

    return res.status(200).json({ success: true, id });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({
      invoiceId: req.params.id,
      error: errorMessage,
      durationMs: Date.now() - startedAt
    }, 'invoice patch failed');
    return res.status(500).json({ success: false, error: errorMessage });
  }
});

invoiceRouter.delete('/:id', async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Valid invoice id is required' });
    }

    const deleted = await deleteInvoice(id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }

    return res.status(200).json({ success: true, id });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({
      invoiceId: req.params.id,
      error: errorMessage,
      durationMs: Date.now() - startedAt
    }, 'invoice delete failed');
    return res.status(500).json({ success: false, error: errorMessage });
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

invoiceRouter.post('/morning/refresh-category-names', async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const { invoiceIds, dryRun = false } = req.body || {};

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
    const categoriesById = new Map(categories.map((category) => [category.id, category]));
    const invoices = (await getInvoices())
      .filter((invoice) => !requestedIds || requestedIds.has(Number(invoice.id)))
      .filter((invoice) => Boolean(invoice.morningCategoryId));

    const results: CategoryRefreshResult[] = [];

    for (const invoice of invoices) {
      if (!invoice.id) continue;

      const oldCategory = {
        oldCategoryId: invoice.morningCategoryId ?? null,
        oldCategoryName: invoice.morningCategoryName ?? null,
        oldCategoryCode: invoice.morningCategoryCode ?? null
      };
      const currentCategory = invoice.morningCategoryId
        ? categoriesById.get(invoice.morningCategoryId)
        : null;

      if (!currentCategory) {
        results.push({
          invoiceId: invoice.id,
          success: true,
          skipped: true,
          ...oldCategory,
          changed: false,
          error: 'Morning category ID was not found in current Morning categories'
        });
        continue;
      }

      const nextCategory = toStoredMorningCategory(currentCategory);
      const changed =
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
    }

    const updatedCount = results.filter((result) => result.success && result.changed).length;
    const missingCount = results.filter((result) => result.skipped).length;

    logger.info({
      requestedCount: requestedIds?.size ?? null,
      processedCount: results.length,
      updatedCount,
      missingCount,
      dryRun: Boolean(dryRun),
      categoryCount: categories.length,
      durationMs: Date.now() - startedAt
    }, 'invoice morning category names refreshed');

    return res.status(200).json({
      success: true,
      processedCount: results.length,
      updatedCount,
      missingCount,
      dryRun: Boolean(dryRun),
      results
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({
      error: errorMessage,
      durationMs: Date.now() - startedAt
    }, 'invoice morning category names refresh failed');

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

invoiceRouter.post('/morning/migrate-environment', async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const dryRun = req.body?.dryRun !== false;
    const categories = await getMorningAccountingClassificationOptions(true);
    const categoryNames = new Map<string, MorningAccountingClassificationOption[]>();

    for (const category of categories) {
      const name = category.name?.trim();
      if (!name) continue;
      const matches = categoryNames.get(name) || [];
      matches.push(category);
      categoryNames.set(name, matches);
    }

    const invoices = await getInvoices();
    const results: MorningEnvironmentMigrationResult[] = [];

    for (const invoice of invoices) {
      if (!invoice.id) continue;

      const oldCategory = {
        oldCategoryId: invoice.morningCategoryId ?? null,
        oldCategoryName: invoice.morningCategoryName ?? null,
        oldCategoryCode: invoice.morningCategoryCode ?? null
      };
      const categoryName = invoice.morningCategoryName?.trim();

      if (!categoryName) {
        results.push({
          invoiceId: invoice.id,
          success: true,
          skipped: true,
          ...oldCategory,
          changed: false,
          error: 'Invoice does not have a Morning category name'
        });
        continue;
      }

      const matches = categoryNames.get(categoryName) || [];
      if (matches.length === 0) {
        results.push({
          invoiceId: invoice.id,
          success: true,
          skipped: true,
          ...oldCategory,
          changed: false,
          error: 'No exact Morning category name match was found'
        });
        continue;
      }

      if (matches.length > 1) {
        results.push({
          invoiceId: invoice.id,
          success: true,
          skipped: true,
          ...oldCategory,
          changed: false,
          error: 'More than one Morning category has this exact name'
        });
        continue;
      }

      const nextCategory = toStoredMorningCategory(matches[0]);
      const changed =
        (invoice.morningCategoryId ?? null) !== nextCategory.morningCategoryId ||
        (invoice.morningCategoryCode ?? null) !== nextCategory.morningCategoryCode ||
        (invoice.morningCategoryName ?? null) !== nextCategory.morningCategoryName;

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
    }

    let syncResetCount = invoices.length;
    if (!dryRun) {
      syncResetCount = await resetAllMorningSyncStatuses();
    }

    const changedCategoryCount = results.filter((result) => result.success && result.changed).length;
    const skippedCategoryCount = results.filter((result) => result.skipped).length;

    logger.info({
      dryRun,
      invoiceCount: invoices.length,
      categoryCount: categories.length,
      syncResetCount,
      changedCategoryCount,
      skippedCategoryCount,
      durationMs: Date.now() - startedAt
    }, 'morning environment migration completed');

    return res.status(200).json({
      success: true,
      dryRun,
      invoiceCount: invoices.length,
      categoryCount: categories.length,
      syncResetCount,
      changedCategoryCount,
      skippedCategoryCount,
      results
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({
      error: errorMessage,
      durationMs: Date.now() - startedAt
    }, 'morning environment migration failed');
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
          ? await updateInvoiceInMorning(invoice, existingExpenseId)
          : await sendInvoiceToMorning(invoice);
        const expenseId = morningResult.expenseId;

        if (!expenseId) {
          throw new Error('Morning did not return an expense ID');
        }

        await updateMorningSyncStatus(id, 'sent', expenseId, null);

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
          skipped: false,
          morningExpenseId: expenseId,
          morningFileSyncStatus,
          morningFileSyncError
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await updateMorningSyncStatus(id, 'failed', invoice.morningExpenseId ?? null, errorMessage);
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
