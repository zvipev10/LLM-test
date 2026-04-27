import { StoredInvoice } from '../database/invoiceService';
import { logger } from '../logger';

type MorningTokenResponse = {
  token?: string;
  expires?: number;
  expiresAt?: number;
};

type MorningExpenseResponse = {
  id?: string | number;
  [key: string]: unknown;
};

let cachedToken: string | null = null;
let cachedTokenExpiresAt = 0;

function getApiBase() {
  return (process.env.GREEN_INVOICE_API_BASE || 'https://sandbox.d.greeninvoice.co.il/api/v1').replace(/\/$/, '');
}

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function requestMorning<T>(path: string, options: RequestInit = {}, useAuth = true): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string> | undefined) || {})
  };

  if (useAuth) {
    headers.Authorization = `Bearer ${await getMorningToken()}`;
  }

  const response = await fetch(`${getApiBase()}${path}`, {
    ...options,
    headers
  });

  const body = await parseJsonResponse(response);
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? String((body as { message?: unknown }).message)
        : typeof body === 'object' && body !== null && 'error' in body
          ? String((body as { error?: unknown }).error)
        : JSON.stringify(body);
    throw new Error(`Morning API ${response.status}: ${message}`);
  }

  return body as T;
}

async function getMorningToken() {
  const now = Date.now();
  if (cachedToken && cachedTokenExpiresAt > now + 60_000) {
    return cachedToken;
  }

  const startedAt = Date.now();
  const tokenResponse = await requestMorning<MorningTokenResponse>(
    '/account/token',
    {
      method: 'POST',
      body: JSON.stringify({
        id: getRequiredEnv('GREEN_INVOICE_API_ID'),
        secret: getRequiredEnv('GREEN_INVOICE_API_SECRET')
      })
    },
    false
  );

  if (!tokenResponse.token) {
    throw new Error('Morning API did not return an auth token');
  }

  cachedToken = tokenResponse.token;
  const tokenExpiry =
    typeof tokenResponse.expiresAt === 'number'
      ? tokenResponse.expiresAt
      : typeof tokenResponse.expires === 'number'
        ? Date.now() + tokenResponse.expires * 1000
        : Date.now() + 50 * 60 * 1000;
  cachedTokenExpiresAt = tokenExpiry;

  logger.info({
    durationMs: Date.now() - startedAt,
    apiBase: getApiBase()
  }, 'morning token refreshed');

  return cachedToken;
}

function formatDate(value: string | null | undefined) {
  return value || new Date().toISOString().slice(0, 10);
}

function formatAmount(value: number | null | undefined) {
  return Number((value ?? 0).toFixed(2));
}

function getExpenseId(response: MorningExpenseResponse) {
  if (typeof response.id === 'string') return response.id;
  if (typeof response.id === 'number') return String(response.id);
  return null;
}

export async function sendInvoiceToMorning(invoice: StoredInvoice) {
  if (!invoice.id) {
    throw new Error('Invoice must be saved before sending to Morning');
  }
  if (!invoice.vendorName) {
    throw new Error('Invoice supplier is required before sending to Morning');
  }
  if (invoice.totalWithVat == null) {
    throw new Error('Invoice total is required before sending to Morning');
  }

  const startedAt = Date.now();
  const invoiceDate = formatDate(invoice.date);
  const payload = {
    paymentType: Number(process.env.GREEN_INVOICE_EXPENSE_PAYMENT_TYPE || 2),
    currency: invoice.currency || 'ILS',
    currencyRate: 1,
    vat: formatAmount(invoice.vat),
    amount: formatAmount(invoice.totalWithVat),
    date: invoiceDate,
    dueDate: invoiceDate,
    reportingDate: invoiceDate.slice(0, 7) + '-01',
    documentType: Number(process.env.GREEN_INVOICE_EXPENSE_DOCUMENT_TYPE || 20),
    number: String(invoice.id),
    description: invoice.fileName || `Invoice ${invoice.id}`,
    remarks: `Imported from VAT Report invoice ${invoice.id}`,
    supplier: {
      name: invoice.vendorName,
      active: true,
      country: 'IL'
    },
    active: true,
    addRecipient: true
  };

  const response = await requestMorning<MorningExpenseResponse>('/expenses', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  const expenseId = getExpenseId(response);
  logger.info({
    invoiceId: invoice.id,
    expenseId,
    durationMs: Date.now() - startedAt
  }, 'invoice sent to morning');

  return {
    expenseId,
    response
  };
}
