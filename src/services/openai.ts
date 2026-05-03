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

function buildCategorySelectionPrompt(params: {
  invoice: {
    fileName?: string | null;
    vendorName?: string | null;
    date?: string | null;
    totalWithVat?: number | null;
    totalWithoutVat?: number | null;
    currency?: string | null;
    currentMorningCategoryId?: string | null;
    currentMorningCategoryName?: string | null;
    currentMorningCategoryCode?: number | null;
  };
  categories: MorningAccountingClassificationOption[];
}) {
  const categoryList = params.categories.map((category) => ({
    id: category.id,
    name: category.name,
    code: category.code
  }));

  return `You choose the best Morning accounting category for an existing invoice.

Use the invoice fields and the current Morning category list. Choose one category only from the list.
If the current category is still the best fit, choose it again.
If no category reasonably fits, return null.

INVOICE:
${JSON.stringify(params.invoice, null, 2)}

MORNING CATEGORY LIST:
${JSON.stringify(categoryList, null, 2)}

RESPOND WITH ONLY A VALID JSON OBJECT:

{
  "morningCategoryId": "category id from list or null"
}`;
}

export type GmailInvoiceResolution = {
  kind: 'invoice_body' | 'invoice_link' | 'not_invoice';
  selectedLink: string | null;
  reason: string | null;
};

function buildGmailInvoiceResolutionPrompt(params: {
  subject: string;
  fromAddress: string;
  textBody: string;
  htmlText: string;
  links: Array<{ url: string; text: string; source: string }>;
}) {
  const maxBodyChars = 12_000;
  const textBody = params.textBody.slice(0, maxBodyChars);
  const htmlText = params.htmlText.slice(0, maxBodyChars);
  const links = params.links.slice(0, 40);

  return `You inspect Gmail messages that may contain invoices.

Decide whether this email:
1. is itself an invoice/receipt in the email body,
2. contains a link that should be opened to get the invoice/receipt,
3. is not an invoice.

Prefer invoice_link when there is a clear download/view invoice link.
Choose only one selectedLink, and only from the provided links.
If the email body contains the full invoice details such as vendor, date, amount, tax/VAT, or receipt/invoice number, use invoice_body.
If it is not invoice-related, use not_invoice.

EMAIL:
Subject: ${params.subject}
From: ${params.fromAddress}

TEXT BODY:
${textBody}

HTML TEXT:
${htmlText}

LINKS:
${JSON.stringify(links, null, 2)}

RESPOND WITH ONLY A VALID JSON OBJECT:

{
  "kind": "invoice_body" | "invoice_link" | "not_invoice",
  "selectedLink": "exact url from LINKS or null",
  "reason": "short reason"
}`;
}

export async function resolveGmailInvoiceSource(params: {
  subject: string;
  fromAddress: string;
  textBody: string;
  htmlText: string;
  links: Array<{ url: string; text: string; source: string }>;
}): Promise<GmailInvoiceResolution> {
  const response = await client.responses.create({
    model: 'gpt-5.4',
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: buildGmailInvoiceResolutionPrompt(params),
          }
        ]
      }
    ],
    max_output_tokens: 300,
    temperature: 0,
  });

  const content = response.output_text;
  if (!content) throw new Error('No response from OpenAI');

  const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const parsed = JSON.parse(cleaned) as GmailInvoiceResolution;

  if (!['invoice_body', 'invoice_link', 'not_invoice'].includes(parsed.kind)) {
    throw new Error(`Invalid Gmail invoice resolution kind: ${parsed.kind}`);
  }

  if (parsed.kind === 'invoice_link') {
    const selected = params.links.find((link) => link.url === parsed.selectedLink);
    if (!selected) {
      throw new Error('OpenAI selected a link that was not provided');
    }
  }

  return {
    kind: parsed.kind,
    selectedLink: parsed.selectedLink || null,
    reason: parsed.reason || null
  };
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

export async function selectMorningCategoryForInvoice(
  invoice: {
    fileName?: string | null;
    vendorName?: string | null;
    date?: string | null;
    totalWithVat?: number | null;
    totalWithoutVat?: number | null;
    currency?: string | null;
    morningCategoryId?: string | null;
    morningCategoryName?: string | null;
    morningCategoryCode?: number | null;
  },
  categories: MorningAccountingClassificationOption[]
): Promise<MorningAccountingClassificationOption | null> {
  const response = await client.responses.create({
    model: 'gpt-5.4',
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: buildCategorySelectionPrompt({
              invoice: {
                fileName: invoice.fileName ?? null,
                vendorName: invoice.vendorName ?? null,
                date: invoice.date ?? null,
                totalWithVat: invoice.totalWithVat ?? null,
                totalWithoutVat: invoice.totalWithoutVat ?? null,
                currency: invoice.currency ?? null,
                currentMorningCategoryId: invoice.morningCategoryId ?? null,
                currentMorningCategoryName: invoice.morningCategoryName ?? null,
                currentMorningCategoryCode: invoice.morningCategoryCode ?? null
              },
              categories
            }),
          }
        ]
      }
    ],
    max_output_tokens: 150,
    temperature: 0,
  });

  const content = response.output_text;
  if (!content) throw new Error('No response from OpenAI');

  const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const parsed = JSON.parse(cleaned) as { morningCategoryId?: string | null };
  if (!parsed.morningCategoryId) return null;

  const selected = categories.find((category) => category.id === parsed.morningCategoryId);
  if (!selected) {
    throw new Error('OpenAI selected a Morning category that was not provided');
  }

  return selected;
}
