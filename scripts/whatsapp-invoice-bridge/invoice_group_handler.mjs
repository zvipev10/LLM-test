import { put } from '@vercel/blob/client';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

function normalizeBaseUrl(value) {
  const normalized = String(value || '').trim().replace(/\/$/, '');
  if (!normalized.startsWith('https://')) {
    throw new Error('INVOICE_API_BASE_URL must be an HTTPS URL');
  }
  return normalized;
}

function fileNameFor(event, filePath) {
  return path.basename(event.fileName || filePath || 'receipt');
}

async function readJsonResponse(response, operation) {
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    throw new Error(body?.error || `${operation} failed with HTTP ${response.status}`);
  }
  return body;
}

function formatTotal(totalWithVat, currency = 'ILS') {
  if (!Number.isFinite(Number(totalWithVat))) return 'לא זוהה';

  try {
    return new Intl.NumberFormat('he-IL', {
      style: 'currency',
      currency: currency || 'ILS',
      maximumFractionDigits: 2,
    }).format(Number(totalWithVat));
  } catch {
    return `${Number(totalWithVat).toFixed(2)} ${currency || 'ILS'}`;
  }
}

export function formatInvoiceUploadConfirmation(invoice) {
  return [
    'הצלחה בהעלאת הקובץ',
    `תאריך: ${invoice?.date || 'לא זוהה'}`,
    `סכום: ${formatTotal(invoice?.totalWithVat, invoice?.currency)}`,
  ].join('\n');
}

export function createInvoiceGroupHandler({
  apiBaseUrl,
  fetchImpl = globalThis.fetch,
  putBlob = put,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const baseUrl = normalizeBaseUrl(apiBaseUrl);
  const completedMessageIds = new Set();

  async function uploadOne(event, filePath) {
    const fileName = fileNameFor(event, filePath);
    const mimeType = String(event.mime || 'application/octet-stream').toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new Error(`Unsupported receipt type: ${mimeType}`);
    }

    const size = statSync(filePath).size;
    if (size < 1) throw new Error('Receipt file is empty');
    if (size > maxBytes) throw new Error('Receipt file exceeds the 10 MB limit');

    const tokenResponse = await fetchImpl(`${baseUrl}/blob-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: fileName, contentType: mimeType, size }),
      signal: AbortSignal.timeout(30000),
    });
    const tokenResult = await readJsonResponse(tokenResponse, 'Invoice blob-token request');

    const fileBuffer = readFileSync(filePath);
    const blob = await putBlob(tokenResult.pathname, fileBuffer, {
      access: 'public',
      token: tokenResult.token,
      contentType: mimeType,
      multipart: true,
    });

    const processResponse = await fetchImpl(`${baseUrl}/process-blob`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: blob.url, filename: fileName, mimeType }),
      signal: AbortSignal.timeout(120000),
    });
    const processResult = await readJsonResponse(processResponse, 'Invoice processing request');
    if (!processResult.result?.success) {
      throw new Error(processResult.result?.error || 'Invoice processing failed');
    }

    const invoice = processResult.result.data || {};
    return {
      fileName,
      invoiceId: processResult.result.id || null,
      duplicate: Boolean(processResult.result.duplicate),
      invoice: {
        date: invoice.date || null,
        totalWithVat: invoice.totalWithVat ?? null,
        currency: invoice.currency || 'ILS',
      },
    };
  }

  return {
    async handle(event) {
      const messageId = String(event?.messageId || '').trim();
      if (messageId && completedMessageIds.has(messageId)) {
        return { duplicateMessage: true, invoiceId: null, files: [] };
      }

      const mediaPaths = Array.isArray(event?.mediaUrls)
        ? event.mediaUrls.filter(Boolean)
        : [];
      if (!event?.hasMedia || mediaPaths.length === 0) {
        throw new Error('Receipt media was not downloaded');
      }

      const files = [];
      for (const filePath of mediaPaths) {
        files.push(await uploadOne(event, filePath));
      }
      if (messageId) completedMessageIds.add(messageId);

      return {
        duplicateMessage: false,
        invoiceId: files[0]?.invoiceId || null,
        invoice: files[0]?.invoice || null,
        files,
      };
    },
  };
}
