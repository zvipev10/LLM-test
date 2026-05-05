import { chromium } from 'playwright';
import sparticuzChromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

export type RenderedPagePdf = {
  buffer: Buffer;
  finalUrl: string;
  title: string;
  bodyPreview: string;
  pdfBytes: number;
  captureMethod: 'html_print';
};

async function renderHtmlToPdfWithPlaywright(html: string): Promise<RenderedPagePdf> {
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

async function renderHtmlToPdfWithBundledChromium(html: string): Promise<RenderedPagePdf> {
  const browser = await puppeteer.launch({
    args: sparticuzChromium.args,
    defaultViewport: {
      width: 1280,
      height: 1800
    },
    executablePath: await sparticuzChromium.executablePath(),
    headless: true
  });

  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7'
    });

    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    try {
      await page.waitForNetworkIdle({ timeout: 10_000 });
    } catch {
      // Email tracking images or remote assets may keep connections open.
    }

    const title = await page.title().catch(() => '');
    const bodyPreview = await page.evaluate(() => (globalThis as any).document?.body?.innerText || '')
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

export async function renderHtmlToPdf(html: string): Promise<RenderedPagePdf> {
  if (process.env.VERCEL) {
    return renderHtmlToPdfWithBundledChromium(html);
  }

  return renderHtmlToPdfWithPlaywright(html);
}
