import { chromium } from 'playwright';
import { readFile } from 'fs/promises';

export type RenderedPagePdf = {
  buffer: Buffer;
  finalUrl: string;
  title: string;
  bodyPreview: string;
  pdfBytes: number;
  captureMethod: 'pdf_response' | 'download' | 'page_print' | 'html_print';
};

export async function renderPageToPdf(url: string): Promise<RenderedPagePdf> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1280, height: 1800 },
      locale: 'he-IL',
      timezoneId: 'Asia/Jerusalem',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7'
      }
    });
    const page = await context.newPage();
    await page.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => undefined });");

    const pdfResponseBodies: Array<Promise<Buffer | null>> = [];
    page.on('response', (response) => {
      const contentType = response.headers()['content-type'] || '';
      const responseUrl = response.url().toLowerCase();
      if (contentType.includes('application/pdf') || responseUrl.endsWith('.pdf')) {
        pdfResponseBodies.push(
          response.body()
            .then((body) => Buffer.from(body))
            .catch(() => null)
        );
      }
    });

    const downloadPromise = page.waitForEvent('download', { timeout: 45_000 })
      .then(async (download) => {
        const path = await download.path();
        return path ? readFile(path) : null;
      })
      .catch(() => null);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('net::ERR_ABORTED')) {
        throw error;
      }
    }

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

    const downloadBuffer = await downloadPromise;
    if (downloadBuffer && downloadBuffer.slice(0, 5).toString('utf8') === '%PDF-') {
      return {
        buffer: downloadBuffer,
        finalUrl: page.url(),
        title,
        bodyPreview,
        pdfBytes: downloadBuffer.length,
        captureMethod: 'download'
      };
    }

    const pdfResponseBuffers = await Promise.all(pdfResponseBodies);
    const pdfResponseBuffer = pdfResponseBuffers.find((buffer) => buffer && buffer.slice(0, 5).toString('utf8') === '%PDF-');
    if (pdfResponseBuffer) {
      return {
        buffer: pdfResponseBuffer,
        finalUrl: page.url(),
        title,
        bodyPreview,
        pdfBytes: pdfResponseBuffer.length,
        captureMethod: 'pdf_response'
      };
    }

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
      captureMethod: 'page_print'
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
      pdfBytes: buffer.length,
      captureMethod: 'html_print'
    };
  } finally {
    await browser.close();
  }
}
