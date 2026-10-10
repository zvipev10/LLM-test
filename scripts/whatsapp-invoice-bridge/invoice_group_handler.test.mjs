import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createInvoiceGroupHandler,
  formatInvoiceUploadConfirmation,
} from './invoice_group_handler.mjs';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('returns extracted invoice details after the Vercel Blob flow', async () => {
  const filePath = path.join(tmpdir(), `hermes-invoice-${Date.now()}.jpg`);
  writeFileSync(filePath, Buffer.from('receipt'));

  try {
    const handler = createInvoiceGroupHandler({
      apiBaseUrl: 'https://example.test/api/invoices',
      fetchImpl: async (url) => url.endsWith('/blob-token')
        ? jsonResponse(200, { success: true, pathname: 'invoice-uploads/test.jpg', token: 'token' })
        : jsonResponse(200, {
          success: true,
          result: {
            success: true,
            id: 42,
            data: { date: '2026-10-10', totalWithVat: 123.45, currency: 'ILS' },
          },
        }),
      putBlob: async () => ({ url: 'https://blob.example.test/test.jpg' }),
    });

    const result = await handler.handle({
      messageId: 'message-1',
      hasMedia: true,
      mediaUrls: [filePath],
      fileName: 'receipt.jpg',
      mime: 'image/jpeg',
    });

    assert.deepEqual(result.invoice, {
      date: '2026-10-10',
      totalWithVat: 123.45,
      currency: 'ILS',
    });
    assert.match(formatInvoiceUploadConfirmation(result.invoice), /תאריך: 2026-10-10/);
    assert.match(formatInvoiceUploadConfirmation(result.invoice), /סכום:/);
  } finally {
    unlinkSync(filePath);
  }
});

test('does not make network calls for unsupported receipt types', async () => {
  const filePath = path.join(tmpdir(), `hermes-invoice-${Date.now()}.txt`);
  writeFileSync(filePath, Buffer.from('not a receipt'));
  let requested = false;

  try {
    const handler = createInvoiceGroupHandler({
      apiBaseUrl: 'https://example.test/api/invoices',
      fetchImpl: async () => {
        requested = true;
        throw new Error('unexpected request');
      },
    });

    await assert.rejects(
      handler.handle({
        messageId: 'message-2',
        hasMedia: true,
        mediaUrls: [filePath],
        fileName: 'receipt.txt',
        mime: 'text/plain',
      }),
      /Unsupported receipt type/
    );
    assert.equal(requested, false);
  } finally {
    unlinkSync(filePath);
  }
});
