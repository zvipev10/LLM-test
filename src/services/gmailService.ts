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

function getClient() {
  if (!tokens) {
    throw new Error('Gmail not connected')
  }
  oAuth2Client.setCredentials(tokens)
  return google.gmail({ version: 'v1', auth: oAuth2Client })
}

function extractHeader(headers: any[] | undefined, name: string) {
  return headers?.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value || ''
}

function collectAttachments(parts: any[] | undefined): string[] {
  if (!parts) return []
  const result: string[] = []

  const walk = (items: any[]) => {
    items.forEach((part) => {
      if (part.filename) {
        result.push(part.filename)
      }
      if (part.parts) {
        walk(part.parts)
      }
    })
  }

  walk(parts)
  return result
}

export async function fetchEmails() {
  const gmail = getClient()

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: process.env.GMAIL_QUERY || 'newer_than:30d has:attachment',
    maxResults: 20
  })

  const messages = listRes.data.messages || []

  const fullMessages = await Promise.all(
    messages.map(async (msg) => {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'full'
      })

      const payload = full.data.payload
      const headers = payload?.headers || []
      const attachments = collectAttachments(payload?.parts)

      return {
        gmailMessageId: full.data.id || '',
        threadId: full.data.threadId || '',
        subject: extractHeader(headers, 'Subject'),
        fromAddress: extractHeader(headers, 'From'),
        receivedAt: extractHeader(headers, 'Date'),
        snippet: full.data.snippet || '',
        attachments
      }
    })
  )

  return fullMessages
}
