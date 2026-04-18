import { Router } from 'express';
import db from '../database/db';
import { getAuthUrl, handleOAuthCallback, fetchEmails, getGmailClient } from '../services/gmailService';

export const gmailRouter = Router();

gmailRouter.get('/connect', (req, res) => {
  const url = getAuthUrl();
  res.redirect(url);
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

    db.prepare('DELETE FROM gmail_staging').run();

    const insert = db.prepare(`
      INSERT INTO gmail_staging (
        gmailMessageId, threadId, fromAddress, subject, snippet, receivedAt,
        hasAttachments, attachmentNames, fileName, mimeType, gmailAttachmentId, sourceType
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let count = 0;

    emails.forEach(email => {
      if (email.attachments.length > 0) {
        email.attachments.forEach((att: any) => {
          insert.run(
            email.gmailMessageId,
            email.threadId,
            email.fromAddress,
            email.subject,
            email.snippet,
            new Date(email.receivedAt).toISOString(),
            1,
            JSON.stringify([att.fileName]),
            att.fileName,
            att.mimeType,
            att.attachmentId,
            'attachment'
          );
          count++;
        });
      } else {
        insert.run(
          email.gmailMessageId,
          email.threadId,
          email.fromAddress,
          email.subject,
          email.snippet,
          new Date(email.receivedAt).toISOString(),
          0,
          '[]',
          `${email.subject || 'mail'}.pdf`,
          'application/pdf',
          null,
          'generated'
        );
        count++;
      }
    });

    res.json({ success: true, count });

  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// FIXED AUTH
gmailRouter.get('/file/:id', async (req, res) => {
  const row = db.prepare('SELECT * FROM gmail_staging WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).send('Not found');

  if (row.sourceType === 'generated') {
    const content = `Subject: ${row.subject}\nFrom: ${row.fromAddress}\n\n${row.snippet}`;
    res.setHeader('Content-Type', 'application/pdf');
    return res.send(Buffer.from(content));
  }

  try {
    const gmail = getGmailClient();

    const attachment = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: row.gmailMessageId,
      id: row.gmailAttachmentId
    });

    const buffer = Buffer.from(attachment.data.data, 'base64');

    res.setHeader('Content-Type', row.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${row.fileName}"`);
    res.send(buffer);

  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to fetch attachment');
  }
});

gmailRouter.get('/results', (req, res) => {
  const rows = db.prepare('SELECT * FROM gmail_staging ORDER BY createdAt DESC').all();
  res.json({ success: true, results: rows });
});
