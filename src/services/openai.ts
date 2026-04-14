import OpenAI from 'openai';
import { InvoiceData } from '../types/invoice';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const EXTRACTION_PROMPT = `You are an invoice and receipt data extraction assistant.

You must follow a STRICT 3-stage process internally and only output the final JSON.

----------------------------------------
STAGE 1 — EXTRACT ALL NUMERIC VALUES
----------------------------------------

Extract ALL monetary values from the document.

For each value, create an object with:
- rawText: exact text as appears
- numericValue: number
- currency: detected currency (e.g. ILS)
- contextText: exact nearby text (same line or closest label)

----------------------------------------
STAGE 2 — CLASSIFY EACH VALUE
----------------------------------------

For each extracted value, assign:

- type: one of:
  [total_with_vat, total_without_vat, vat_amount, unit_price, line_item, subtotal, other, unknown]

- isFinalCandidate: true/false

Classification rules:

- total_with_vat:
  MUST appear near labels like:
  "סה\"כ", "סה\"כ לתשלום", "לתשלום", "סה\"כ חשבונית"

- total_without_vat:
  MUST appear near:
  "לפני מע\"מ"

- vat_amount:
  MUST appear near:
  "מע\"מ"

- unit_price:
  MUST be associated with units like:
  "לליטר", "למ\"ק", "ליחידה"

- line_item:
  itemized charges (gas, שירות, תשלום קבוע וכו')

- If unsure → type = unknown (DO NOT GUESS)

isFinalCandidate = true ONLY IF:
- type is total_with_vat or total_without_vat
AND
- context clearly indicates a payment summary

----------------------------------------
STAGE 3 — SELECT FINAL VALUES
----------------------------------------

Selection rules:

- totalWithVat:
  Choose the value where:
  type = total_with_vat
  AND isFinalCandidate = true

- If multiple candidates:
  choose the one with the highest numericValue

- totalWithoutVat:
  Prefer value with type = total_without_vat and isFinalCandidate = true

- If not found:
  calculate from totalWithVat using 18% VAT

STRICT EXCLUSIONS:
- NEVER use values classified as:
  unit_price, line_item, subtotal

- NEVER use a value unless its rawText EXACTLY appears in the document

----------------------------------------
DATE RULES
----------------------------------------

- Extract only the date labeled:
  "תאריך החשבונית"

- Ignore all other dates (meter readings, deposits, etc.)

- Convert to ISO format (YYYY-MM-DD)

----------------------------------------
VENDOR NAME
----------------------------------------

- Use exact printed name
- If first line is document type, use next line

----------------------------------------
OUTPUT
----------------------------------------

Return ONLY:

{
  "vendorName": "...",
  "date": "YYYY-MM-DD",
  "totalWithVat": number,
  "totalWithoutVat": number,
  "currency": "ILS",
  "confidence": "high | medium | low"
}

----------------------------------------
VALIDATION (MANDATORY)
----------------------------------------

Before finalizing:
- Ensure selected totals appear near "סה\"כ" or payment labels
- Ensure they are NOT unit prices
- Ensure they are among the largest values in the document

If any rule is violated → return null for that field`;

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
