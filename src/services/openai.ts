import OpenAI from 'openai';
import { InvoiceData } from '../types/invoice';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const EXTRACTION_PROMPT = `You are an invoice and receipt data extraction assistant.
Analyze the provided image and extract the following information:
- vendorName: the exact business name as it appears printed on the document. Do NOT infer, guess or expand the name. If the first line is a document type (e.g. "חשבונית", "Invoice", "Receipt"), use the next line as the vendor name instead.
- date: the date of the invoice/receipt in ISO format (YYYY-MM-DD). Look carefully for dates in any format including DD/MM/YY, MM/DD/YY, YY/MM/DD, or written out. A 2-digit year like 26 means 2026.
- totalWithVat: the final total amount paid including VAT/tax as a number
- totalWithoutVat: the amount before VAT/tax as a number
- currency: the 3-letter currency code (e.g. USD, EUR, GBP, ILS for Israeli Shekel)
- confidence: your confidence in the extraction (high/medium/low)

Rules:
- Copy text EXACTLY as it appears on the document — never infer or hallucinate values
- Hebrew text is right-to-left (RTL). Always return Hebrew text in correct RTL reading order. Never reverse Hebrew characters or words.
- Search the ENTIRE image carefully for dates, including headers, footers and small print
- If a field cannot be found, return null for that field
- Return ONLY a valid JSON object, no explanation or markdown
- Numbers should be plain numbers, not strings (e.g. 100.50 not "100.50")
- For receipts in Hebrew, the date may appear near the top or bottom with the time
- If there are multiple dates, use the invoice date or "תאריך החשבונית". Not the print date or any of transaction dates
- The date must be copied character-by-character exactly as it appears next to the label "תאריך החשבונית"
- Do not reformat, reorder, or reinterpret the date
- If the extracted date is not identical to a substring in the document, return null
- If there is no two separate total with and without VAT, return the total amount for totalWithVat and calculate totalWithoutVat by removing a standard VAT percentage of 18%
- The first line of a document is often its TYPE (invoice/receipt), not the vendor name

Example output:
{
  "vendorName": "חניון מרכז עזריאלי",
  "date": "2026-03-30",
  "totalWithVat": 25.00,
  "totalWithoutVat": 21.19,
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
