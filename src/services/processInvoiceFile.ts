import { extractInvoiceData } from './openai';
import { convertPdfToImage } from './pdf';

function getPngHeaderHex(buffer: Buffer) {
  return buffer.slice(0, 8).toString('hex');
}

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

    if (!imageBuffer || imageBuffer.length < 8) {
      throw new Error(`PDF conversion returned empty/short image buffer for ${fileName}`);
    }

    const pngHeader = getPngHeaderHex(imageBuffer);
    if (!pngHeader.startsWith('89504e47')) {
      throw new Error(`PDF conversion returned non-PNG data for ${fileName}. Header: ${pngHeader}`);
    }
  }

  try {
    const invoiceData = await extractInvoiceData(imageBuffer, imageMimeType);

    return {
      success: true,
      filename: fileName,
      mimeType,
      data: invoiceData,
      fileData: fileBuffer.toString('base64')
    };
  } catch (err: any) {
    throw new Error(
      `Invoice extraction failed for ${fileName}. Input mime=${imageMimeType}, size=${imageBuffer?.length || 0}, original mime=${mimeType}. ${err?.message || err}`
    );
  }
}
