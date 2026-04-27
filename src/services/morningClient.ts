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

type MorningAccountingClassification = {
  id?: string;
  key?: string;
  code?: string;
  title?: string;
  type?: number;
  vat?: number;
  [key: string]: unknown;
};

type MorningFileUploadUrlResponse = {
  url?: string;
  fields?: Record<string, string | number | boolean>;
};

let cachedToken: string | null = null;
let cachedTokenExpiresAt = 0;
let cachedAccountingClassifications: MorningAccountingClassification[] | null = null;

function getApiBase() {
  return (process.env.GREEN_INVOICE_API_BASE || 'https://sandbox.d.greeninvoice.co.il/api/v1').replace(/\/$/, '');
}

function getFileUploadUrl() {
  if (process.env.GREEN_INVOICE_FILE_UPLOAD_URL) {
    return process.env.GREEN_INVOICE_FILE_UPLOAD_URL;
  }

  if (getApiBase().includes('sandbox')) {
    return 'https://api.sandbox.d.greeninvoice.co.il/file-upload/v1/url';
  }

  return 'https://apigw.greeninvoice.co.il/file-upload/v1/url';
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

async function requestMorningFileUploadUrl(expenseId: string) {
  const url = new URL(getFileUploadUrl());
  url.searchParams.set('context', 'expense');
  url.searchParams.set('data', JSON.stringify({ source: 5, id: expenseId, state: 'expense' }));

  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await getMorningToken()}`
    }
  });

  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Morning file URL API ${response.status}: ${JSON.stringify(body)}`);
  }

  return body as MorningFileUploadUrlResponse;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function collectAccountingClassifications(value: unknown, results: MorningAccountingClassification[] = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectAccountingClassifications(item, results));
    return results;
  }

  if (!isObject(value)) return results;

  if (typeof value.id === 'string' && (typeof value.title === 'string' || typeof value.key === 'string')) {
    results.push(value as MorningAccountingClassification);
  }

  Object.values(value).forEach((item) => collectAccountingClassifications(item, results));
  return results;
}

async function getAccountingClassifications() {
  if (cachedAccountingClassifications) {
    return cachedAccountingClassifications;
  }

  const startedAt = Date.now();
  const response = await requestMorning<unknown>('/accounting/classifications/map');
  cachedAccountingClassifications = collectAccountingClassifications(response);

  logger.info({
    count: cachedAccountingClassifications.length,
    durationMs: Date.now() - startedAt
  }, 'morning accounting classifications fetched');

  return cachedAccountingClassifications;
}

async function getExpenseAccountingClassification() {
  const classifications = await getAccountingClassifications();
  const configuredId = process.env.GREEN_INVOICE_ACCOUNTING_CLASSIFICATION_ID;
  const configuredKey = process.env.GREEN_INVOICE_ACCOUNTING_CLASSIFICATION_KEY;

  const selected =
    classifications.find((classification) => configuredId && classification.id === configuredId) ||
    classifications.find((classification) => configuredKey && classification.key === configuredKey) ||
    classifications.find((classification) => classification.type === 20) ||
    classifications[0];

  if (!selected) {
    throw new Error('Morning expense classification is required, but no accounting classifications were found');
  }

  logger.info({
    classificationId: selected.id,
    classificationKey: selected.key,
    classificationTitle: selected.title
  }, 'morning accounting classification selected');

  return selected;
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
  const accountingClassification = await getExpenseAccountingClassification();
  const payload = {
    paymentType: Number(process.env.GREEN_INVOICE_EXPENSE_PAYMENT_TYPE || 11),
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
    accountingClassification,
    active: true,
    addRecipient: true,
    addAccountingClassification: true
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

export async function uploadInvoiceFileToMorningExpense(params: {
  expenseId: string;
  invoiceId: number;
  fileName: string;
  mimeType?: string | null;
  fileBuffer: Buffer;
}) {
  const startedAt = Date.now();
  const uploadData = await requestMorningFileUploadUrl(params.expenseId);

  if (!uploadData.url || !uploadData.fields) {
    throw new Error('Morning did not return file upload URL fields');
  }

  const formData = new FormData();
  Object.entries(uploadData.fields).forEach(([field, value]) => {
    formData.append(field, String(value));
  });
  formData.append(
    'file',
    new Blob([new Uint8Array(params.fileBuffer)], { type: params.mimeType || 'application/octet-stream' }),
    params.fileName
  );

  const response = await fetch(uploadData.url, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Morning file upload ${response.status}: ${body || response.statusText}`);
  }

  logger.info({
    invoiceId: params.invoiceId,
    expenseId: params.expenseId,
    durationMs: Date.now() - startedAt
  }, 'invoice file uploaded to morning');
}
