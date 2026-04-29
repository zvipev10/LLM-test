import { chromium } from 'playwright';

export async function renderPageToPdf(url: string): Promise<Buffer> {
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

    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
