import { Router, Request, Response } from 'express';
import { upload } from '../middleware/upload';
import { extractInvoiceData } from '../services/openai';
import { convertPdfToImage } from '../services/pdf';
import { InvoiceResponse, ErrorResponse } from '../types/invoice';
import { getInvoices, getInvoiceStats, syncInvoices, getInvoiceFileData, clearAllInvoices } from '../database/invoiceService';
import { resetDatabaseFile } from '../database/db';

export const invoiceRouter = Router();

invoiceRouter.get('/reset-db-file', (_req: Request, res: Response) => {
  try {
    resetDatabaseFile();
    return res.status(200).json({
      success: true,
      message: 'Database file deleted and recreated successfully'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reset DB file'
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
        files.map(async (file) => {
          try {
            const { buffer, mimetype, originalname } = file;

            let imageBuffer = buffer;
            let imageMimeType = mimetype;

            if (mimetype === 'application/pdf') {
              imageBuffer = await convertPdfToImage(buffer);
              imageMimeType = 'image/png';
            }

            const invoiceData = await extractInvoiceData(imageBuffer, imageMimeType);
            const base64File = buffer.toString('base64');

            return {
              success: true,
              filename: originalname,
              mimeType: mimetype,
              data: invoiceData,
              fileData: base64File
            } as InvoiceResponse & { fileData: string };
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

invoiceRouter.post('/save-batch', (req: Request, res: Response) => {
  try {
    const { invoices } = req.body;

    if (!Array.isArray(invoices)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid invoices data'
      });
    }

    console.log(`[SAVE] Received ${invoices.length} invoices`);
    invoices.forEach((inv, idx) => {
      const hasFileData = !!inv.fileData;
      const fileDataLength = hasFileData ? (typeof inv.fileData === 'string' ? inv.fileData.length : 'unknown') : 0;
      console.log(`[SAVE] Invoice ${idx}: id=${inv.id ?? 'new'}, fileName=${inv.fileName}, hasFileData=${hasFileData}, fileDataLength=${fileDataLength}, mimeType=${inv.mimeType}`);
    });

    try {
      console.log('[SAVE] Syncing invoices with database snapshot...');
      const ids = syncInvoices(invoices);

      console.log(`[SAVE] Successfully synced ${ids.length} invoices to database`);

      return res.status(200).json({
        success: true,
        message: `Database updated with ${ids.length} invoices`,
        savedCount: ids.length
      });
    } catch (dbError) {
      console.error('[SAVE] Database operation failed:', dbError);
      throw dbError;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[SAVE] Save batch failed:', errorMessage, error);
    return res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

invoiceRouter.post('/reset-db', (_req: Request, res: Response) => {
  try {
    const deleted = clearAllInvoices();
    return res.status(200).json({
      success: true,
      message: `Deleted ${deleted} invoices`
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reset DB'
    });
  }
});

invoiceRouter.get('/list', (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;

    const invoices = getInvoices({ limit, offset });
    return res.status(200).json({
      success: true,
      invoices
    });
  } catch (error) {
    console.error('[LIST] Failed to retrieve invoices:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    });
  }
});

invoiceRouter.get('/file/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const invoiceId = parseInt(id);

    if (isNaN(invoiceId)) {
      return res.status(400).json({ success: false, error: 'Invalid invoice ID' });
    }

    const fileData = getInvoiceFileData(invoiceId);

    if (!fileData || !fileData.fileData) {
      console.error(`File not found for invoice ${invoiceId}`);
      return res.status(404).json({ success: false, error: 'File not found or no file data stored' });
    }

    try {
      const buffer = Buffer.from(fileData.fileData, 'base64');

      res.set('Content-Type', fileData.mimeType);
      res.set('Content-Disposition', 'inline');
      res.send(buffer);
    } catch (conversionErr) {
      console.error(`Failed to convert base64 for invoice ${invoiceId}:`, conversionErr);
      return res.status(500).json({ success: false, error: 'Failed to process file data' });
    }
  } catch (error) {
    console.error('File retrieval error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to retrieve file'
    });
  }
});

invoiceRouter.get('/stats', (req: Request, res: Response) => {
  try {
    const stats = getInvoiceStats();
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
