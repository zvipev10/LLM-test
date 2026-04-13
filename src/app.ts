import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { invoiceRouter } from './routes/invoices';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/invoices', invoiceRouter);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
