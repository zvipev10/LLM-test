import { Router } from 'express';
import { getAuthUrl, handleOAuthCallback, fetchEmails, downloadAttachment, createSimplePdfBuffer } from '../services/gmailService';
import { processInvoiceFile } from '../services/processInvoiceFile';

export const gmailRouter = Router();

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
          const pdfBuffer = createSimplePdfBuffer([
            `Subject: ${email.subject}`,
            `From: ${email.fromAddress}`,
            email.snippet
          ]);

          const processed = await processInvoiceFile(pdfBuffer, 'application/pdf', `${email.subject || 'mail'}.pdf`);
          results.push({ ...processed, source: 'gmail' });
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
