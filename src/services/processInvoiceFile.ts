import { extractInvoiceData } from './openai';
import { convertPdfToImage } from './pdf';
import { getMorningAccountingClassificationOptions } from './morningClient';
import type { MorningAccountingClassificationOption } from './morningClient';

function normalizeExtractedCategory(invoiceData: any, categories: MorningAccountingClassificationOption[]) {
  const selected = categories.find((category) => category.id === invoiceData.morningCategoryId);
  if (!selected) {
    invoiceData.morningCategoryId = null;
    invoiceData.morningCategoryName = null;
    invoiceData.morningCategoryCode = null;
    return;
  }

  invoiceData.morningCategoryId = selected.id;
  invoiceData.morningCategoryName = selected.name;
  if (selected.code === null || selected.code === undefined) {
    invoiceData.morningCategoryCode = null;
    return;
  }

  const numericCode = typeof selected.code === 'number' ? selected.code : Number(selected.code);
  invoiceData.morningCategoryCode = Number.isFinite(numericCode) ? numericCode : null;
}

function getPngHeaderHex(buffer: Buffer) {
  return buffer.slice(0, 8).toString('hex');
}

function looksLikePdf(fileBuffer: Buffer, mimeType: string, fileName: string) {
  const lowerName = (fileName || '').toLowerCase();
  const pdfSignature = fileBuffer.slice(0, 5).toString('utf8') === '%PDF-';

  return (
    mimeType === 'application/pdf' ||
    lowerName.endsWith('.pdf') ||
    pdfSignature
  );
}

function normalizeOriginalMimeType(fileBuffer: Buffer, mimeType: string, fileName: string) {
  const lowerName = (fileName || '').toLowerCase();
  const pdfSignature = fileBuffer.slice(0, 5).toString('utf8') === '%PDF-';
  const pngSignature = fileBuffer.slice(0, 8).toString('hex').startsWith('89504e47');
  const jpgSignature = fileBuffer.slice(0, 3).toString('hex') === 'ffd8ff';

  if (pdfSignature || lowerName.endsWith('.pdf')) return 'application/pdf';
  if (pngSignature || lowerName.endsWith('.png')) return 'image/png';
  if (jpgSignature || lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  return mimeType;
}

export async function processInvoiceFile(
  fileBuffer: Buffer,
  mimeType: string,
  fileName: string
) {
  let imageBuffer = fileBuffer;
  let imageMimeType = mimeType;

  if (looksLikePdf(fileBuffer, mimeType, fileName)) {
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
    const categories = await getMorningAccountingClassificationOptions();
    const invoiceData = await extractInvoiceData(imageBuffer, imageMimeType, categories);
    normalizeExtractedCategory(invoiceData, categories);

    return {
      success: true,
      filename: fileName,
      mimeType: normalizeOriginalMimeType(fileBuffer, mimeType, fileName),
      data: invoiceData,
      fileData: fileBuffer.toString('base64')
    };
  } catch (err: any) {
    throw new Error(
      `Invoice extraction failed for ${fileName}. Input mime=${imageMimeType}, size=${imageBuffer?.length || 0}, original mime=${mimeType}. ${err?.message || err}`
    );
  }
}
