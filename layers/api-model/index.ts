export class ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: any;

  constructor(success: boolean, data?: T, message?: string, error?: any) {
    this.success = success;
    if (data !== undefined) this.data = data;
    if (message !== undefined) this.message = message;
    if (error !== undefined) this.error = error;
  }
}

export class LambdaResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  isBase64Encoded: boolean;

  constructor(
    statusCode: number,
    bodyObj: object,
    headers: Record<string, string> = { 'Content-Type': 'application/json' },
    isBase64Encoded: boolean = false
  ) {
    this.statusCode = statusCode;
    this.body = JSON.stringify(bodyObj);
    this.headers = headers;
    this.isBase64Encoded = isBase64Encoded;
  }
}

export class ResponsePage<T = any> {
  pageNumber: number;
  pageSize: number;
  totalCount: number;
  items: T[];

  constructor(pageNumber: number, pageSize: number, totalCount: number, items: T[]) {
    this.pageNumber = pageNumber;
    this.pageSize = pageSize;
    this.totalCount = totalCount;
    this.items = items;
  }
}
