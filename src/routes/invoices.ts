import { Router, Request, Response } from 'express';
import { upload } from '../middleware/upload';
import { extractInvoiceData } from '../services/openai';
import { convertPdfToImage } from '../services/pdf';
import { InvoiceResponse, ErrorResponse } from '../types/invoice';

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
