import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { invoiceRouter } from './routes/invoices';
import { gmailRouter } from './routes/gmail';
import { initializeDatabase } from './database/db';
import { logger } from './logger';
import { initializeMorningAccountingClassifications } from './services/morningClient';

dotenv.config();

initializeDatabase();

initializeMorningAccountingClassifications().catch((error) => {
  logger.error({
    error: error instanceof Error ? error.message : String(error)
  }, 'morning accounting classifications startup refresh failed');
});

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use((req, res, next) => {
  const shouldSkipTimingLog =
    req.originalUrl.startsWith('/api/invoices/upload') ||
    req.originalUrl.startsWith('/api/gmail/sync');

  if (shouldSkipTimingLog) {
    return next();
  }

  const startedAt = Date.now();

  res.on('finish', () => {
    logger.info({
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt
    }, 'request completed');
  });

  return next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/invoices', invoiceRouter);
app.use('/api/gmail', gmailRouter);

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'server started');
});

export default app;
