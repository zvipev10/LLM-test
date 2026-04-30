import { Router } from 'express';
import { getAuthUrl, handleOAuthCallback, fetchEmails, downloadAttachment, createSimplePdfBuffer } from '../services/gmailService';
import { processInvoiceFile } from '../services/processInvoiceFile';
import { resolveGmailInvoiceSource } from '../services/openai';
import { renderHtmlToPdf } from '../services/browserRenderer';
import { logger } from '../logger';

export const gmailRouter = Router();

function sanitizeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 120) || 'mail';
}

type GmailDebug = {
  path?: string;
  selectedLink?: string | null;
  resolutionKind?: string;
  resolutionReason?: string | null;
  renderFinalUrl?: string;
  renderTitle?: string;
  renderBodyPreview?: string;
  renderPdfBytes?: number;
  renderCaptureMethod?: string;
  error?: string;
};

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
      const baseDebug = {
        gmailMessageId: email.gmailMessageId,
        subject: email.subject,
        fromAddress: email.fromAddress,
        attachmentCount: email.attachments.length,
        attachments: email.attachments.map((attachment: any) => ({
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          hasAttachmentId: Boolean(attachment.attachmentId)
        })),
        linkCount: email.links.length,
        links: email.links
      };

      logger.info(baseDebug, 'gmail sync email inspected');

      if (email.attachments.length > 0) {
        for (const att of email.attachments) {
          const gmailDebug: GmailDebug = {
            path: 'attachment'
          };

          try {
            const buffer = await downloadAttachment(email.gmailMessageId, att.attachmentId);
            const processed = await processInvoiceFile(buffer, att.mimeType, att.fileName);
            logger.info({
              ...baseDebug,
              path: 'attachment',
              fileName: att.fileName,
              mimeType: att.mimeType,
              bytes: buffer.length
            }, 'gmail sync attachment processed');
            results.push({ ...processed, source: 'gmail', gmailDebug });
          } catch (err: any) {
            gmailDebug.path = 'failed';
            gmailDebug.error = err.message;
            logger.error({
              ...baseDebug,
              path: 'attachment',
              fileName: att.fileName,
              error: err.message
            }, 'gmail sync attachment failed');
            results.push({ success: false, filename: att.fileName, error: err.message, gmailDebug });
          }
        }
      } else {
        const gmailDebug: GmailDebug = {};

        try {
          const resolution = await resolveGmailInvoiceSource({
            subject: email.subject,
            fromAddress: email.fromAddress,
            textBody: email.textBody,
            htmlText: email.htmlText,
            links: email.links
          });
          gmailDebug.resolutionKind = resolution.kind;
          gmailDebug.selectedLink = resolution.selectedLink;
          gmailDebug.resolutionReason = resolution.reason;

          logger.info({
            ...baseDebug,
            resolution
          }, 'gmail sync invoice source resolved');

          if (resolution.kind === 'not_invoice') {
            gmailDebug.path = 'not_invoice';
            results.push({
              success: false,
              skipped: true,
              filename: `${sanitizeFileName(email.subject || 'mail')}.pdf`,
              error: resolution.reason || 'Email does not look like an invoice',
              gmailDebug
            });
            continue;
          }

          if (resolution.kind === 'invoice_link' && resolution.selectedLink) {
            gmailDebug.path = 'client_capture_required';
            logger.info({
              ...baseDebug,
              ...gmailDebug
            }, 'gmail sync linked invoice requires client capture');
            results.push({
              success: false,
              needsClientCapture: true,
              filename: `${sanitizeFileName(email.subject || 'invoice-from-link')}.pdf`,
              error: 'Client browser capture required',
              source: 'gmail',
              gmailResolution: 'client_capture_required',
              gmailSourceUrl: resolution.selectedLink,
              gmailDebug
            });
            continue;
          }

          let pdfBuffer: Buffer;
          if (email.htmlBody) {
            const rendered = await renderHtmlToPdf(email.htmlBody);
            pdfBuffer = rendered.buffer;
            gmailDebug.renderFinalUrl = rendered.finalUrl;
            gmailDebug.renderTitle = rendered.title;
            gmailDebug.renderBodyPreview = rendered.bodyPreview;
            gmailDebug.renderPdfBytes = rendered.pdfBytes;
            gmailDebug.renderCaptureMethod = rendered.captureMethod;
          } else {
            const bodyLines = [
              `Subject: ${email.subject}`,
              `From: ${email.fromAddress}`,
              `Date: ${email.receivedAt}`,
              '',
              ...(email.textBody || email.htmlText || email.snippet).split('\n').filter(Boolean)
            ];
            pdfBuffer = createSimplePdfBuffer(bodyLines);
          }

          const processed = await processInvoiceFile(pdfBuffer, 'application/pdf', `${sanitizeFileName(email.subject || 'mail')}.pdf`);
          gmailDebug.path = 'email_body';
          logger.info({
            ...baseDebug,
            path: 'email_body',
            pdfBytes: pdfBuffer.length,
            renderTitle: gmailDebug.renderTitle,
            renderBodyPreview: gmailDebug.renderBodyPreview,
            renderCaptureMethod: gmailDebug.renderCaptureMethod
          }, 'gmail sync email body processed');
          results.push({ ...processed, source: 'gmail', gmailResolution: 'email_body', gmailDebug });
        } catch (err: any) {
          gmailDebug.path = 'failed';
          gmailDebug.error = err.message;
          logger.error({
            ...baseDebug,
            ...gmailDebug,
            error: err.message
          }, 'gmail sync email failed');
          results.push({ success: false, filename: `${email.subject || 'mail'}.pdf`, error: err.message, gmailDebug });
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
