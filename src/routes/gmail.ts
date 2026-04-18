import { Router } from 'express';
import db from '../database/db';
import { getAuthUrl, handleOAuthCallback, fetchEmails } from '../services/gmailService';

export const gmailRouter = Router();

gmailRouter.get('/connect', (req, res) => {
  const url = getAuthUrl();
  res.redirect(url);
});

gmailRouter.get('/callback', async (req, res) => {
  try {
    const code = req.query.code as string;

    if (!code) {
      return res.status(400).send('Missing OAuth code');
    }

    await handleOAuthCallback(code);
    res.send('Gmail connected successfully');
  } catch (err: any) {
    console.error('Gmail OAuth callback failed:', err);

    const envDebug = {
      hasClientId: !!process.env.GOOGLE_CLIENT_ID,
      hasClientSecret: !!process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_REDIRECT_URI || null,
    };

    const errorMessage = err?.message || 'Unknown OAuth error';
    const details = err?.response?.data ? JSON.stringify(err.response.data) : '';

    res.status(500).send(
      `OAuth failed\n\nmessage: ${errorMessage}\n\ndetails: ${details}\n\nenv: ${JSON.stringify(envDebug, null, 2)}`
    );
  }
});

function classify(subject: string, attachments: string[]) {
  const text = (subject + ' ' + attachments.join(' ')).toLowerCase();

  if (text.includes('invoice') || text.includes('חשבונית')) {
    return { category: 'invoice', isRelevant: 1, confidence: 'high', reason: 'invoice detected' };
  }

  if (text.includes('order') || text.includes('payment')) {
    return { category: 'purchase', isRelevant: 1, confidence: 'medium', reason: 'purchase detected' };
  }

  return { category: 'other', isRelevant: 0, confidence: 'low', reason: 'not relevant' };
}

gmailRouter.post('/sync', async (req, res) => {
  try {
    const emails = await fetchEmails();

    db.prepare('DELETE FROM gmail_staging').run();

    const insert = db.prepare(`
      INSERT INTO gmail_staging (
        gmailMessageId, threadId, fromAddress, subject, snippet, receivedAt,
        hasAttachments, attachmentNames, category, isRelevant, confidence, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let relevantCount = 0;

    emails.forEach(email => {
      const cls = classify(email.subject, email.attachments);
      if (cls.isRelevant) relevantCount++;

      insert.run(
        email.gmailMessageId,
        email.threadId,
        email.fromAddress,
        email.subject,
        email.snippet,
        new Date(email.receivedAt).toISOString(),
        email.attachments.length > 0 ? 1 : 0,
        JSON.stringify(email.attachments),
        cls.category,
        cls.isRelevant,
        cls.confidence,
        cls.reason
      );
    });

    res.json({ success: true, scannedCount: emails.length, relevantCount });

  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

gmailRouter.get('/results', (req, res) => {
  const rows = db.prepare('SELECT * FROM gmail_staging ORDER BY createdAt DESC').all();
  res.json({ success: true, results: rows });
});
