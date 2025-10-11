/**
 * WDR Models Layer
 * 
 * Core API response models and simple creation functions.
 * 
 * Usage:
 * ```typescript
 * import { ApiResponse, success, error } from 'wdr-models';
 * import { ERROR_CODES } from 'wdr-error-codes';
 * 
 */

// Core type definitions
export type ErrorCodeType = {
  code: number;
  errorCode: string;
  defaultMessage: string;
};

/**
 * Core API response model
 */
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
    headers: Record<string, string> = { 'Content-Type': 'application/json' , 'Access-Control-Allow-Origin': '*' },
    isBase64Encoded: boolean = false
  ) {
    this.statusCode = statusCode;
    this.body = JSON.stringify(bodyObj);
    this.headers = headers;
    this.isBase64Encoded = isBase64Encoded;
  }

  static success(data: ApiResponse, statusCode: number = 200): LambdaResponse {
    return new LambdaResponse(statusCode, data);
  }

  static error(error: ApiResponse, statusCode: number = 500): LambdaResponse {
    return new LambdaResponse(statusCode, error);
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

// Generate a export function that create ApiResponse use the ErrorCodeType.code as code, ErrorCodeType.defaultMessage as message
export function createApiResponse<T>(success: boolean, errorCode: ErrorCodeType, data?: T): ApiResponse<T> {
  return new ApiResponse<T>(success, data, errorCode.defaultMessage, errorCode.code);
}
