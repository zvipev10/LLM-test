import OpenAI from 'openai';
import { InvoiceData } from '../types/invoice';
import type { MorningAccountingClassificationOption } from './morningClient';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function buildExtractionPrompt(categories: MorningAccountingClassificationOption[]) {
  const categoryList = categories.map((category) => ({
    id: category.id,
    name: category.name,
    code: category.code
  }));

  return `You are an invoice and receipt data extraction assistant.

STAGE 1 - go through the attached file, row by row and explain in your words what you understand from it. Extract maximum information without skipping any piece of data, especially dates and numeric values.

STAGE 2 - classify each useful value from stage 1 into the following fields:

- vendor name: best guess for the vendor name. If not explicitly stated, try to extract it from the document, such as from the header or logo. If it logically cannot be extracted, return null.
- total with vat.
- total without vat: if not explicitly stated, calculate from total_with_vat using 18% VAT. If it logically cannot be extracted or calculated, return the same value as total_with_vat, assuming the invoice might be VAT-free.
- date: best fit for the invoice date, not due date or payment date. Convert to ISO format (YYYY-MM-DD).
- currency: if not explicitly stated, assume ILS.
- Morning category: choose the single best category from the provided Morning category list according to the vendor, document text, invoice/receipt descriptions, and extracted values. Use only an id from this list. If no category reasonably fits, return null for all Morning category fields.
- confidence: high, medium, or low.

MORNING CATEGORY LIST:
${JSON.stringify(categoryList, null, 2)}

RESPOND WITH ONLY A VALID JSON OBJECT, NO OTHER TEXT, NO EXPLANATIONS:

{
  "vendorName": "...",
  "date": "YYYY-MM-DD",
  "totalWithVat": number,
  "totalWithoutVat": number,
  "currency": "ILS",
  "morningCategoryId": "category id from list or null",
  "morningCategoryName": "category name from list or null",
  "morningCategoryCode": number,
  "confidence": "high" | "medium" | "low"
}`;
}

export async function extractInvoiceData(
  fileBuffer: Buffer,
  mimeType: string,
  categories: MorningAccountingClassificationOption[] = []
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
            detail: 'high',
          },
          {
            type: 'input_text',
            text: buildExtractionPrompt(categories),
          }
        ]
      }
    ],
    max_output_tokens: 700,
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
