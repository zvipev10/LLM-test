import { Router } from 'express';
import db from '../database/db';

export const gmailRouter = Router();

// simple heuristic classifier
function classify(subject: string, snippet: string, attachments: string[]) {
  const text = (subject + ' ' + snippet + ' ' + attachments.join(' ')).toLowerCase();

  if (text.includes('invoice') || text.includes('חשבונית') || text.includes('receipt') || text.includes('קבלה')) {
    return { category: 'invoice_attachment', isRelevant: 1, confidence: 'high', reason: 'Detected invoice keywords' };
  }

  if (text.includes('order') || text.includes('payment') || text.includes('תשלום')) {
    return { category: 'purchase', isRelevant: 1, confidence: 'medium', reason: 'Purchase-related content' };
  }

  return { category: 'other', isRelevant: 0, confidence: 'low', reason: 'No relevant signals' };
}

// MOCK / MVP sync (no OAuth yet)
gmailRouter.post('/sync', async (req, res) => {
  try {
    // TODO: replace with real Gmail API later
    const mockEmails = [
      {
        gmailMessageId: '1',
        threadId: 't1',
        fromAddress: 'billing@amazon.com',
        subject: 'Your invoice is ready',
        snippet: 'Please find your invoice attached',
        receivedAt: new Date().toISOString(),
        hasAttachments: 1,
        attachments: ['invoice_123.pdf']
      },
      {
        gmailMessageId: '2',
        threadId: 't2',
        fromAddress: 'noreply@shop.com',
        subject: 'Order confirmation',
        snippet: 'Thank you for your order',
        receivedAt: new Date().toISOString(),
        hasAttachments: 0,
        attachments: []
      }
    ];

    db.prepare('DELETE FROM gmail_staging').run();

    let relevantCount = 0;

    const insert = db.prepare(`
      INSERT INTO gmail_staging (
        gmailMessageId, threadId, fromAddress, subject, snippet, receivedAt,
        hasAttachments, attachmentNames, category, isRelevant, confidence, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    mockEmails.forEach(email => {
      const cls = classify(email.subject, email.snippet, email.attachments);
      if (cls.isRelevant) relevantCount++;

      insert.run(
        email.gmailMessageId,
        email.threadId,
        email.fromAddress,
        email.subject,
        email.snippet,
        email.receivedAt,
        email.hasAttachments,
        JSON.stringify(email.attachments),
        cls.category,
        cls.isRelevant,
        cls.confidence,
        cls.reason
      );
    });

    return res.json({
      success: true,
      scannedCount: mockEmails.length,
      relevantCount
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// fetch staged results
gmailRouter.get('/results', (req, res) => {
  const rows = db.prepare('SELECT * FROM gmail_staging ORDER BY createdAt DESC').all();
  return res.json({ success: true, results: rows });
});
