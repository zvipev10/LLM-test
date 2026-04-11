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

  if (!result?.buffer) {
    throw new Error('Failed to convert PDF to image');
  }

  return result.buffer;
}
