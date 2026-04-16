import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { invoiceRouter } from './routes/invoices';
import { initializeDatabase } from './database/db';

dotenv.config();

// Initialize SQLite database
initializeDatabase();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/invoices', invoiceRouter);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
