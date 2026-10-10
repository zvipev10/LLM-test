# WhatsApp invoice bridge

This directory is the canonical Heshbonit-specific code for handling invoice attachments sent to WhatsApp.

The Hermes WhatsApp bridge supplies each downloaded image or PDF to `createInvoiceGroupHandler`. The handler validates the file, uploads it through the invoice API's Vercel Blob flow, and returns the extracted invoice details.

The successful WhatsApp response is produced by `formatInvoiceUploadConfirmation`:

```text
הצלחה בהעלאת הקובץ
תאריך: YYYY-MM-DD
סכום: ₪123.45
```

The live Hermes bridge must import this module and call the formatter when it acknowledges a successful upload. Keep the VM copy synchronized from this directory; do not copy runtime credentials or WhatsApp session files into this repository.
