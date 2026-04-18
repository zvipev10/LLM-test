import OpenAI from 'openai';
import { InvoiceData } from '../types/invoice';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const EXTRACTION_PROMPT = `You are an invoice and receipt data extraction assistant.

STAGE 1 — go through the attached file, row by row and explain in your words what you understand from it. maximum information without skipping any piece of data (dates and numbers values)

STAGE 2 — classify each number value in the result of first stage into one of the following:

- vendor name: best guess for the vendor name. if not explicitly stated, try to extract it from the document (e.g. from the header, from the logo, etc.). if logically cannot be extracted, return null
- total with vat
- total without vat: if not explicitly stated, calculate from total_with_vat using 18% VAT. if logically cannot be extracted or calculated, return the same value as total_with_vat (assuming the invoice might be VAT-free)
- date: best fit for the invoice date (not due date, not payment date, etc.). Convert to ISO format (YYYY-MM-DD)
- currency: if not explicitly stated, assume it's ILS
- confidence: high, medium, or low

RESPOND WITH ONLY A VALID JSON OBJECT, NO OTHER TEXT, NO EXPLANATIONS:

{
  "vendorName": "...",
  "date": "YYYY-MM-DD",
  "totalWithVat": number,
  "totalWithoutVat": number,
  "currency": "ILS",
  "confidence": "high" | "medium" | "low"
}`;

export async function extractInvoiceData(
  fileBuffer: Buffer,
  mimeType: string
): Promise<InvoiceData> {
  if (!mimeType.startsWith('image/')) {
    throw new Error(`Invalid MIME type after preprocessing: ${mimeType}`);
  }

  const base64File = fileBuffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64File}`;

  const response = await client.responses.create({
    model: 'gpt-5.4',
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_image',
            image_url: dataUrl,
          },
          {
            type: 'input_text',
            text: EXTRACTION_PROMPT,
          }
        ]
      }
    ],
    max_output_tokens: 500,
    temperature: 0,
  });

  const content = response.output_text;
  if (!content) throw new Error('No response from OpenAI');

  const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  try {
    return JSON.parse(cleaned) as InvoiceData;
  } catch (parseError) {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as InvoiceData;
      } catch (e) {
        throw new Error(`Failed to parse extracted JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    throw new Error(`Invalid JSON response: ${parseError instanceof Error ? parseError.message : String(parseError)}. Response: ${cleaned.substring(0, 200)}`);
  }
}
