import { Router } from 'express';
import { getAuthUrl, handleOAuthCallback, fetchEmails, downloadAttachment, createSimplePdfBuffer } from '../services/gmailService';
import { extractInvoiceData } from '../services/openai';
import { convertPdfToImage } from '../services/pdf';

export const gmailRouter = Router();

gmailRouter.get('/connect', (req, res) => {
  res.redirect(getAuthUrl());
});

gmailRouter.get('/callback', async (req, res) => {
  try {
    const code = req.query.code as string;
    if (!code) return res.status(400).send('Missing OAuth code');
    await handleOAuthCallback(code);
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
            const originalBuffer = await downloadAttachment(email.gmailMessageId, att.attachmentId);

            let imageBuffer = originalBuffer;
            let imageMimeType = att.mimeType;

            if (att.mimeType === 'application/pdf') {
              imageBuffer = await convertPdfToImage(originalBuffer);
              imageMimeType = 'image/png';
            }

            const data = await extractInvoiceData(imageBuffer, imageMimeType);

            results.push({
              success: true,
              filename: att.fileName,
              mimeType: att.mimeType,
              data,
              fileData: originalBuffer.toString('base64'),
              source: 'gmail'
            });
          } catch (err: any) {
            results.push({
              success: false,
              filename: att.fileName,
              error: err.message
            });
          }
        }
      } else {
        try {
          const pdfBuffer = createSimplePdfBuffer([
            `Subject: ${email.subject}`,
            `From: ${email.fromAddress}`,
            email.snippet
          ]);

          const imageBuffer = await convertPdfToImage(pdfBuffer);
          const data = await extractInvoiceData(imageBuffer, 'image/png');

          results.push({
            success: true,
            filename: `${email.subject || 'mail'}.pdf`,
            mimeType: 'application/pdf',
            data,
            fileData: pdfBuffer.toString('base64'),
            source: 'gmail'
          });
        } catch (err: any) {
          results.push({
            success: false,
            filename: `${email.subject || 'mail'}.pdf`,
            error: err.message
          });
        }
      }
    }

    res.json({
      success: true,
      total: results.length,
      results
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
