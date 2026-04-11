import OpenAI from 'openai';
import { InvoiceData } from '../types/invoice';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const EXTRACTION_PROMPT = `You are an invoice data extraction assistant.
Analyze the provided invoice image and extract the following information:
- vendorName: the name of the company or person issuing the invoice
- date: the invoice date in ISO format (YYYY-MM-DD)
- totalWithVat: the total amount including VAT/tax as a number
- totalWithoutVat: the total amount excluding VAT/tax as a number
- currency: the 3-letter currency code (e.g. USD, EUR, GBP)
- confidence: your confidence in the extraction (high/medium/low)

Rules:
- If a field cannot be found, return null for that field
- Return ONLY a valid JSON object, no explanation or markdown
- Numbers should be plain numbers, not strings (e.g. 100.50 not "100.50")

Example output:
{
  "vendorName": "Acme Corp",
  "date": "2024-01-15",
  "totalWithVat": 121.00,
  "totalWithoutVat": 100.00,
  "currency": "USD",
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
