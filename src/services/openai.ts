import OpenAI from 'openai';
import { InvoiceData } from '../types/invoice';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const EXTRACTION_PROMPT = `You are an invoice and receipt data extraction assistant.
Analyze the provided image and extract the following information:
- vendorName: the name of the company or person issuing the invoice/receipt
- date: the date of the invoice/receipt in ISO format (YYYY-MM-DD). Look carefully for dates in any format including DD/MM/YY, MM/DD/YY, YY/MM/DD, or written out. A 2-digit year like 26 means 2026.
- totalWithVat: the final total amount paid including VAT/tax as a number
- totalWithoutVat: the amount before VAT/tax as a number
- currency: the 3-letter currency code (e.g. USD, EUR, GBP, ILS for Israeli Shekel)
- confidence: your confidence in the extraction (high/medium/low)

Rules:
- Search the ENTIRE image carefully for dates, including headers, footers and small print
- If a field cannot be found, return null for that field
- Return ONLY a valid JSON object, no explanation or markdown
- Numbers should be plain numbers, not strings (e.g. 100.50 not "100.50")
- For receipts in Hebrew, the date may appear near the bottom with the time

Example output:
{
  "vendorName": "Acme Corp",
  "date": "2026-04-08",
  "totalWithVat": 426.40,
  "totalWithoutVat": 361.36,
  "currency": "ILS",
  "confidence": "high"
}`;


export async function extractInvoiceData(
  fileBuffer: Buffer,
  mimeType: string
): Promise<InvoiceData> {
  const base64File = fileBuffer.toString('base64');
  const imageUrl = `data:${mimeType};base64,${base64File}`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: imageUrl }
          },
          {
            type: 'text',
            text: EXTRACTION_PROMPT
          }
        ]
      }
    ],
    max_tokens: 500,
    temperature: 0
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('No response from OpenAI');

  const cleaned = content.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned) as InvoiceData;
}
