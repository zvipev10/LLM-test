import { fromBuffer } from 'pdf2pic';

export async function convertPdfToImage(
  pdfBuffer: Buffer
): Promise<Buffer> {
  const converter = fromBuffer(pdfBuffer, {
    density: 200,
    format: 'png',
    width: 1654,
    height: 2339
  });

  const result = await converter(1, { responseType: 'buffer' });

  if (!result?.buffer || result.buffer.length === 0) {
    throw new Error(
      'PDF to image conversion failed — ensure GraphicsMagick and Ghostscript are installed'
    );
  }

  // Validate PNG magic bytes: 89 50 4E 47
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
  const isValidPng = PNG_MAGIC.every((byte, i) => result.buffer![i] === byte);
  if (!isValidPng) {
    const got = result.buffer.slice(0, 8).toString('hex');
    throw new Error(`PDF conversion produced invalid image data (header: ${got})`);
  }

  return Buffer.from(result.buffer);
}
