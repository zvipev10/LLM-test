import { Router } from 'express';
import { getAuthUrl, handleOAuthCallback, fetchEmails, downloadAttachment, createSimplePdfBuffer } from '../services/gmailService';
import { processInvoiceFile } from '../services/processInvoiceFile';
import { resolveGmailInvoiceSource } from '../services/openai';
import { renderPageToPdf } from '../services/browserRenderer';

export const gmailRouter = Router();

function sanitizeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 120) || 'mail';
}

function getMimeTypeFromUrl(url: string) {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith('.pdf')) return 'application/pdf';
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  if (pathname.endsWith('.webp')) return 'image/webp';
  return null;
}

function getFileNameFromUrl(url: string, fallback: string) {
  const pathname = new URL(url).pathname;
  const lastSegment = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
  return sanitizeFileName(lastSegment || fallback);
}

async function fetchInvoiceLinkAsFile(url: string, fallbackName: string) {
  const response = await fetch(url);
  const mimeTypeFromUrl = getMimeTypeFromUrl(url);
  const responseContentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const contentType = responseContentType === 'application/octet-stream'
    ? mimeTypeFromUrl || responseContentType
    : responseContentType || mimeTypeFromUrl || 'text/html';

  if (!response.ok) {
    throw new Error(`Invoice link returned ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (contentType === 'application/pdf' || contentType.startsWith('image/')) {
    return {
      buffer,
      mimeType: contentType,
      fileName: getFileNameFromUrl(url, fallbackName),
      sourceKind: 'linked_file' as const
    };
  }

  return {
    buffer: await renderPageToPdf(url),
    mimeType: 'application/pdf',
    fileName: fallbackName.toLowerCase().endsWith('.pdf') ? fallbackName : `${fallbackName}.pdf`,
    sourceKind: 'linked_page' as const
  };
}

gmailRouter.get('/connect', (req, res) => {
  res.redirect(getAuthUrl());
});

gmailRouter.get('/callback', async (req, res) => {
  try {
    const code = req.query.code as string;
    if (!code) return res.status(400).send('Missing OAuth code');

    await handleOAuthCallback(code);

    const returnUrl = process.env.GMAIL_RETURN_URL;
    if (returnUrl) {
      const separator = returnUrl.includes('?') ? '&' : '?';
      return res.redirect(`${returnUrl}${separator}gmail_connected=1`);
    }

    res.send('Gmail connected successfully');
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

gmailRouter.post('/sync', async (req, res) => {
  try {
    const emails = await fetchEmails();
    const results: any[] = [];

    for (const email of emails) {
      if (email.attachments.length > 0) {
        for (const att of email.attachments) {
          try {
            const buffer = await downloadAttachment(email.gmailMessageId, att.attachmentId);
            const processed = await processInvoiceFile(buffer, att.mimeType, att.fileName);
            results.push({ ...processed, source: 'gmail' });
          } catch (err: any) {
            results.push({ success: false, filename: att.fileName, error: err.message });
          }
        }
      } else {
        try {
          const resolution = await resolveGmailInvoiceSource({
            subject: email.subject,
            fromAddress: email.fromAddress,
            textBody: email.textBody,
            htmlText: email.htmlText,
            links: email.links
          });

          if (resolution.kind === 'not_invoice') {
            results.push({
              success: false,
              skipped: true,
              filename: `${sanitizeFileName(email.subject || 'mail')}.pdf`,
              error: resolution.reason || 'Email does not look like an invoice'
            });
            continue;
          }

          if (resolution.kind === 'invoice_link' && resolution.selectedLink) {
            const linkedFile = await fetchInvoiceLinkAsFile(
              resolution.selectedLink,
              sanitizeFileName(email.subject || 'invoice-from-link')
            );
            const processed = await processInvoiceFile(linkedFile.buffer, linkedFile.mimeType, linkedFile.fileName);
            results.push({
              ...processed,
              source: 'gmail',
              gmailResolution: linkedFile.sourceKind,
              gmailSourceUrl: resolution.selectedLink
            });
            continue;
          }

          const bodyLines = [
            `Subject: ${email.subject}`,
            `From: ${email.fromAddress}`,
            `Date: ${email.receivedAt}`,
            '',
            ...(email.textBody || email.htmlText || email.snippet).split('\n').filter(Boolean)
          ];

          const pdfBuffer = createSimplePdfBuffer(bodyLines);
          const processed = await processInvoiceFile(pdfBuffer, 'application/pdf', `${sanitizeFileName(email.subject || 'mail')}.pdf`);
          results.push({ ...processed, source: 'gmail', gmailResolution: 'email_body' });
        } catch (err: any) {
          results.push({ success: false, filename: `${email.subject || 'mail'}.pdf`, error: err.message });
        }
      }
    }

    res.json({ success: true, total: results.length, results });
  } catch (err: any) {
    if (err?.message === 'Gmail not connected') {
      return res.status(401).json({ success: false, error: 'Gmail not connected' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});
