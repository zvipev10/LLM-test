export async function convertPdfToImage(
  pdfBuffer: Buffer
): Promise<Buffer> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<typeof import('pdf-to-img')>;
  const { pdf } = await dynamicImport('pdf-to-img');
  const dataUrl = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;
  const document = await pdf(dataUrl, { scale: 3 });
  const imageBuffer = await document.getPage(1);

  if (!imageBuffer || imageBuffer.length === 0) {
    throw new Error('PDF to image conversion failed');
  }

  // Validate PNG magic bytes: 89 50 4E 47
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
  const isValidPng = PNG_MAGIC.every((byte, i) => imageBuffer[i] === byte);
  if (!isValidPng) {
    const got = imageBuffer.slice(0, 8).toString('hex');
    throw new Error(`PDF conversion produced invalid image data (header: ${got})`);
  }

  return Buffer.from(imageBuffer);
}
