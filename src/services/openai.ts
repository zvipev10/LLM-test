import OpenAI from 'openai';
import { InvoiceData } from '../types/invoice';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const EXTRACTION_PROMPT = `You are an invoice and receipt data extraction assistant.

STAGE 1 — go through the attached file, row by row and explain in your words what you understand from it. maximum information without skipping any piece of data (dates and numbers values)

STAGE 2 — classify each number value in the result of first stage into one of the following:

- vendorName
- total_with_vat
- total_without_vat: if not explicitly stated, calculate from total_with_vat using 18% VAT
- vat_amount: if not explicitly stated, calculate as total_with_vat - total_without_vat
- date: best fit for the invoice date (not due date, not payment date, etc.). Convert to ISO format (YYYY-MM-DD)
- currency: if not explicitly stated, assume it's ILS
- confidence
Return ONLY:

{
  "vendorName": "...",
  "date": "YYYY-MM-DD",
  "totalWithVat": number,
  "totalWithoutVat": number,
  "currency": "ILS",
  "confidence": "high | medium | low"
}

If any value is not found or cannot be confidently extracted → return null for that field`;

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
