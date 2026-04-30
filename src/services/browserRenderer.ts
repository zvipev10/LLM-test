import { chromium } from 'playwright';

export type RenderedPagePdf = {
  buffer: Buffer;
  finalUrl: string;
  title: string;
  bodyPreview: string;
  pdfBytes: number;
  captureMethod: 'html_print';
};

export async function renderHtmlToPdf(html: string): Promise<RenderedPagePdf> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1800 },
      locale: 'he-IL'
    });

    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    try {
      await page.waitForLoadState('networkidle', { timeout: 10_000 });
    } catch {
      // Email tracking images or remote assets may keep connections open.
    }

    const title = await page.title().catch(() => '');
    const bodyPreview = await page.locator('body').innerText({ timeout: 5_000 })
      .then((text) => text.replace(/\s+/g, ' ').trim().slice(0, 1000))
      .catch(() => '');

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '12mm',
        right: '12mm',
        bottom: '12mm',
        left: '12mm'
      }
    });

    const buffer = Buffer.from(pdf);

    return {
      buffer,
      finalUrl: page.url(),
      title,
      bodyPreview,
      pdfBytes: buffer.length,
      captureMethod: 'html_print'
    };
  } finally {
    await browser.close();
  }
}
