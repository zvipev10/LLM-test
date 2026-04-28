export interface InvoiceData {
  vendorName: string | null;
  date: string | null;
  totalWithVat: number | null;
  totalWithoutVat: number | null;
  currency: string | null;
  morningCategoryId?: string | null;
  morningCategoryName?: string | null;
  morningCategoryCode?: number | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface InvoiceResponse {
  success: boolean;
  filename: string;
  mimeType: string;
  data: InvoiceData;
}

export interface MultiUploadResponse {
  success: boolean;
  total: number;
  results: (InvoiceResponse | FailedFileResponse)[];
}

export interface FailedFileResponse {
  success: false;
  filename: string;
  error: string;
}

export interface ErrorResponse {
  success: false;
  error: string;
}
