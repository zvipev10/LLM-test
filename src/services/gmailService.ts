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

function getFileNameForPart(part: any, index: number) {
  if (part.filename) return part.filename
  if (part.mimeType === 'application/pdf') return `gmail-attachment-${index}.pdf`
  if (part.mimeType === 'image/png') return `gmail-attachment-${index}.png`
  if (part.mimeType === 'image/jpeg') return `gmail-attachment-${index}.jpg`
  return `gmail-attachment-${index}`
}

function isProcessableAttachmentPart(part: any) {
  if (!part?.body) return false
  if (part.filename && (part.body.attachmentId || part.body.data)) return true
  return (
    (part.body.attachmentId || part.body.data) &&
    (
      part.mimeType === 'application/pdf' ||
      part.mimeType?.startsWith('image/')
    )
  )
}

function collectAttachments(payload: any): any[] {
  if (!payload) return []
  const result: any[] = []

  const walk = (part: any) => {
    if (!part) return

    if (isProcessableAttachmentPart(part)) {
      result.push({
        fileName: getFileNameForPart(part, result.length + 1),
        mimeType: part.mimeType,
        attachmentId: part.body.attachmentId,
        data: part.body.data
      })
    }

    if (part.parts) {
      part.parts.forEach(walk)
    }
  }

  walk(payload)
  return result
}

function decodeGmailBodyData(data: string | undefined) {
  if (!data) return ''
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

export function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim()
}

function collectBodyParts(payload: any) {
  const textParts: string[] = []
  const htmlParts: string[] = []

  const walk = (part: any) => {
    if (!part) return

    if (part.mimeType === 'text/plain' && part.body?.data) {
      textParts.push(decodeGmailBodyData(part.body.data))
    }

    if (part.mimeType === 'text/html' && part.body?.data) {
      htmlParts.push(decodeGmailBodyData(part.body.data))
    }

    if (part.parts) {
      part.parts.forEach(walk)
    }
  }

  walk(payload)

  return {
    textBody: textParts.join('\n\n').trim(),
    htmlBody: htmlParts.join('\n\n').trim()
  }
}

function extractLinks(textBody: string, htmlBody: string) {
  const links: Array<{ url: string; text: string; source: 'html' | 'text' }> = []
  const seen = new Set<string>()

  const addLink = (url: string, text: string, source: 'html' | 'text') => {
    const cleanUrl = url.trim()
    if (!cleanUrl || seen.has(cleanUrl)) return
    seen.add(cleanUrl)
    links.push({ url: cleanUrl, text: text.trim(), source })
  }

  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let anchorMatch: RegExpExecArray | null
  while ((anchorMatch = anchorRegex.exec(htmlBody)) !== null) {
    addLink(anchorMatch[1], stripHtml(anchorMatch[2]), 'html')
  }

  const urlRegex = /https?:\/\/[^\s"'<>]+/gi
  const combinedText = `${textBody}\n${stripHtml(htmlBody)}`
  let urlMatch: RegExpExecArray | null
  while ((urlMatch = urlRegex.exec(combinedText)) !== null) {
    addLink(urlMatch[0].replace(/[),.;]+$/g, ''), '', 'text')
  }

  return links
}

async function getExactLabelId(labelName: string): Promise<string | null> {
  const gmail = getGmailClient()
  const labelsRes = await gmail.users.labels.list({ userId: 'me' })
  const labels = labelsRes.data.labels || []
  const match = labels.find((label) => label.name === labelName)
  return match?.id || null
}

export async function fetchEmails() {
  const gmail = getGmailClient()
  const exactLabelName = process.env.GMAIL_LABEL_NAME || 'Heshbonit'
  const exactLabelId = await getExactLabelId(exactLabelName)

  if (!exactLabelId) {
    return []
  }

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: `label:${exactLabelName}`,
    maxResults: 20
  })

  const messages = listRes.data.messages || []

  const fullMessages = await Promise.all(messages.map(async (msg) => {
    const full = await gmail.users.messages.get({ userId: 'me', id: msg.id!, format: 'full' })

    const payload = full.data.payload
    const headers = payload?.headers || []
    const attachments = collectAttachments(payload)
    const { textBody, htmlBody } = collectBodyParts(payload)
    const htmlText = stripHtml(htmlBody)
    const links = extractLinks(textBody, htmlBody)
    const labelIds = full.data.labelIds || []

    return {
      gmailMessageId: full.data.id || '',
      subject: extractHeader(headers, 'Subject'),
      fromAddress: extractHeader(headers, 'From'),
      receivedAt: extractHeader(headers, 'Date'),
      snippet: full.data.snippet || '',
      textBody,
      htmlBody,
      htmlText,
      links,
      attachments,
      labelIds
    }
  }))

  return fullMessages.filter((message) => message.labelIds.includes(exactLabelId))
}

export async function downloadAttachment(messageId: string, attachmentId?: string, inlineData?: string): Promise<Buffer> {
  if (inlineData) {
    return Buffer.from(inlineData.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  }

  if (!attachmentId) {
    throw new Error('Missing Gmail attachment ID')
  }

  const gmail = getGmailClient()
  const attachment = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId })
  const data = attachment.data.data || ''
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function escapePdfText(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

export function createSimplePdfBuffer(lines: string[]): Buffer {
  const wrappedLines = lines.flatMap((line) => {
    const chunks: string[] = []
    const value = line || ''
    for (let i = 0; i < value.length; i += 95) {
      chunks.push(value.slice(i, i + 95))
    }
    return chunks.length > 0 ? chunks : ['']
  }).slice(0, 34)

  const content = wrappedLines.map((l, i) => `BT /F1 12 Tf 50 ${760 - i * 20} Td (${escapePdfText(l)}) Tj ET`).join('\n')
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
