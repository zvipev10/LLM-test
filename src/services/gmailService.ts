import { google } from 'googleapis'

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']

const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
)

let tokens: any = null

export function getAuthUrl() {
  return oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  })
}

export async function handleOAuthCallback(code: string) {
  const { tokens: newTokens } = await oAuth2Client.getToken(code)
  tokens = newTokens
  oAuth2Client.setCredentials(tokens)
}

export function getGmailClient() {
  if (!tokens) throw new Error('Gmail not connected')
  oAuth2Client.setCredentials(tokens)
  return google.gmail({ version: 'v1', auth: oAuth2Client })
}

function extractHeader(headers: any[] | undefined, name: string) {
  return headers?.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value || ''
}

function collectAttachments(parts: any[] | undefined): any[] {
  if (!parts) return []
  const result: any[] = []

  const walk = (items: any[]) => {
    items.forEach((part) => {
      if (part.filename && part.body?.attachmentId) {
        result.push({ fileName: part.filename, mimeType: part.mimeType, attachmentId: part.body.attachmentId })
      }
      if (part.parts) walk(part.parts)
    })
  }

  walk(parts)
  return result
}

export async function fetchEmails() {
  const gmail = getGmailClient()

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: process.env.GMAIL_QUERY || 'label:Heshbonit',
    maxResults: 20
  })

  const messages = listRes.data.messages || []

  return Promise.all(messages.map(async (msg) => {
    const full = await gmail.users.messages.get({ userId: 'me', id: msg.id!, format: 'full' })

    const payload = full.data.payload
    const headers = payload?.headers || []
    const attachments = collectAttachments(payload?.parts)

    return {
      gmailMessageId: full.data.id || '',
      subject: extractHeader(headers, 'Subject'),
      fromAddress: extractHeader(headers, 'From'),
      receivedAt: extractHeader(headers, 'Date'),
      snippet: full.data.snippet || '',
      attachments
    }
  }))
}

export async function downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
  const gmail = getGmailClient()
  const attachment = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId })
  const data = attachment.data.data || ''
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function escapePdfText(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

export function createSimplePdfBuffer(lines: string[]): Buffer {
  const content = lines.map((l, i) => `BT /F1 12 Tf 50 ${760 - i * 20} Td (${escapePdfText(l)}) Tj ET`).join('\n')
  const stream = `${content}\n`

  const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
5 0 obj << /Length ${Buffer.byteLength(stream)} >> stream
${stream}endstream endobj
xref
0 6
0000000000 65535 f 
0000000010 00000 n 
0000000060 00000 n 
0000000117 00000 n 
0000000275 00000 n 
0000000338 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref
${338 + stream.length}
%%EOF`

  return Buffer.from(pdf)
}
