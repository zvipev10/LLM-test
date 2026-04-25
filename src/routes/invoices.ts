import { Router, Request, Response } from 'express';
import { upload } from '../middleware/upload';
import { extractInvoiceData } from '../services/openai';
import { convertPdfToImage } from '../services/pdf';
import { InvoiceResponse, ErrorResponse } from '../types/invoice';
import { getInvoices, getInvoiceFileData, saveInvoice, updateInvoice, deleteInvoice, hasInvoiceChanges } from '../database/invoiceService';

export const invoiceRouter = Router();

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

    const existingInvoices = getInvoices();
    const existingIds = new Set(existingInvoices.map((inv: any) => inv.id));
    const incomingIds = new Set(invoices.filter((inv: any) => inv.id).map((inv: any) => inv.id));

    let deletedCount = 0;

    existingIds.forEach((id) => {
      if (!incomingIds.has(id)) {
        const deleted = deleteInvoice(id);
        if (deleted) deletedCount += 1;
      }
    });

    const ids: number[] = [];
    let savedCount = 0;

    invoices.forEach((invoice, idx) => {
      if (invoice.id) {
        const hasChanges = hasInvoiceChanges(invoice);
        if (hasChanges) {
          const updated = updateInvoice(invoice);
          if (updated) {
            ids.push(invoice.id);
            savedCount += 1;
          }
        }
      } else {
        const id = saveInvoice(invoice, idx);
        ids.push(id);
        savedCount += 1;
      }
    });

    return res.status(200).json({
      success: true,
      message: `Database synced: ${savedCount} saved/updated, ${deletedCount} deleted`,
      savedCount,
      deletedCount
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

invoiceRouter.get('/list', (_req: Request, res: Response) => {
  try {
    const invoices = getInvoices();
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

    const fileData = getInvoiceFileData(invoiceId) as any;

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

invoiceRouter.get('/stats', (_req: Request, res: Response) => {
  try {
    const invoices = getInvoices();
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
