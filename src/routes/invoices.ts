import { Router, Request, Response } from 'express';
import { upload } from '../middleware/upload';
import { extractInvoiceData } from '../services/openai';
import { convertPdfToImage } from '../services/pdf';
import { InvoiceResponse, ErrorResponse } from '../types/invoice';
import { saveInvoice, getInvoices, getInvoiceStats, clearAllInvoices, saveBatch } from '../database/invoiceService';

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

            // Return extracted data WITHOUT saving to DB
            return {
              success: true,
              filename: originalname,
              mimeType: mimetype,
              data: invoiceData
            } as InvoiceResponse;

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

// Save all current invoices to database (clears old data first)
invoiceRouter.post('/save-batch', (req: Request, res: Response) => {
  try {
    const { invoices } = req.body;
    
    if (!Array.isArray(invoices) || invoices.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid invoices data'
      });
    }

    // Clear all existing invoices and save new ones
    clearAllInvoices();
    const ids = saveBatch(invoices);

    return res.status(200).json({
      success: true,
      message: `Database updated with ${ids.length} invoices`,
      savedCount: ids.length
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save invoices'
    });
  }
});

// Get all invoices from database
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
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to retrieve invoices'
    });
  }
});

// Get invoice statistics
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
