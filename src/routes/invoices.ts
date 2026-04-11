import { Router, Request, Response } from 'express';
import { upload } from '../middleware/upload';
import { extractInvoiceData } from '../services/openai';
import { convertPdfToImage } from '../services/pdf';
import { InvoiceResponse, ErrorResponse } from '../types/invoice';

export const invoiceRouter = Router();

invoiceRouter.post(
  '/upload',
  upload.single('invoice'),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file uploaded. Send a file with field name "invoice"'
        } as ErrorResponse);
      }

      const { buffer, mimetype, originalname } = req.file;

      // If PDF, convert to image first
      let imageBuffer = buffer;
      let imageMimeType = mimetype;

      if (mimetype === 'application/pdf') {
        imageBuffer = await convertPdfToImage(buffer);
        imageMimeType = 'image/png';
      }

      // Extract invoice data using GPT-4o
      const invoiceData = await extractInvoiceData(imageBuffer, imageMimeType);

      const response: InvoiceResponse = {
        success: true,
        filename: originalname,
        mimeType: mimetype,
        data: invoiceData
      };

      return res.status(200).json(response);

    } catch (error) {
      console.error('Invoice processing error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      } as ErrorResponse);
    }
  }
);
