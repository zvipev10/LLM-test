import { chromium } from 'playwright';

export type RenderedPagePdf = {
  buffer: Buffer;
  finalUrl: string;
  title: string;
  bodyPreview: string;
  pdfBytes: number;
};

export async function renderPageToPdf(url: string): Promise<RenderedPagePdf> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1800 },
      locale: 'he-IL'
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    try {
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
    } catch {
      // Some invoice pages keep polling; give the app a short render window instead.
    }

    await page.waitForTimeout(3_000);

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
      pdfBytes: buffer.length
    };
  } finally {
    await browser.close();
  }
}

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
      pdfBytes: buffer.length
    };
  } finally {
    await browser.close();
  }
}
