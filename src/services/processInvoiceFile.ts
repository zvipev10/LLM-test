import { extractInvoiceData } from './openai';
import { convertPdfToImage } from './pdf';

export async function processInvoiceFile(
  fileBuffer: Buffer,
  mimeType: string,
  fileName: string
) {
  let imageBuffer = fileBuffer;
  let imageMimeType = mimeType;

  if (mimeType === 'application/pdf') {
    imageBuffer = await convertPdfToImage(fileBuffer);
    imageMimeType = 'image/png';
  }

  const invoiceData = await extractInvoiceData(imageBuffer, imageMimeType);

  return {
    success: true,
    filename: fileName,
    mimeType,
    data: invoiceData,
    fileData: fileBuffer.toString('base64')
  };
}
