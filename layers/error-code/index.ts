type ErrorCodeType = {
  code: number;
  errorCode: string;
  defaultMessage: string;
};

export const ERROR_CODES: { [key: string]: ErrorCodeType } = {
  // --- Validation & Request Errors: 1000–1099
  INVALID_REQUEST: {
    code: 1001,
    errorCode: 'INVALID_REQUEST',
    defaultMessage: 'The request is invalid.'
  },
  MISSING_REQUIRED_FIELD: {
    code: 1002,
    errorCode: 'MISSING_REQUIRED_FIELD',
    defaultMessage: 'Required field is missing.'
  },
  ENTITY_VALIDATION_FAILED: {
    code: 1004,
    errorCode: 'ENTITY_VALIDATION_FAILED',
    defaultMessage: 'Entity validation failed.'
  },

  // --- Authentication & Authorization: 1100–1199
  AUTHENTICATION_FAILED: {
    code: 1101,
    errorCode: 'AUTHENTICATION_FAILED',
    defaultMessage: 'Failed to authenticate user.'
  },
  ACCESS_DENIED: {
    code: 1102,
    errorCode: 'ACCESS_DENIED',
    defaultMessage: 'Access denied for this resource.'
  },

  // --- Resource & CRUD Errors: 1200–1299
  RESOURCE_ALREADY_EXISTS: {
    code: 1201,
    errorCode: 'RESOURCE_ALREADY_EXISTS',
    defaultMessage: 'Resource already exists.'
  },
  RESOURCE_NOT_FOUND: {
    code: 1202,
    errorCode: 'RESOURCE_NOT_FOUND',
    defaultMessage: 'The requested resource does not exist.'
  },
  ENTITY_UPDATE_FAILED: {
    code: 1203,
    errorCode: 'ENTITY_UPDATE_FAILED',
    defaultMessage: 'Failed to update entity.'
  },
  ENTITY_DELETE_FAILED: {
    code: 1204,
    errorCode: 'ENTITY_DELETE_FAILED',
    defaultMessage: 'Failed to delete entity.'
  },

  // --- AWS Lambda Errors: 1300–1399
  LAMBDA_SERVICE_EXCEPTION: {
    code: 1301,
    errorCode: 'LAMBDA_SERVICE_EXCEPTION',
    defaultMessage: 'AWS Lambda service internal error.'
  },
  LAMBDA_THROTTLED: {
    code: 1302,
    errorCode: 'LAMBDA_THROTTLED',
    defaultMessage: 'AWS Lambda request was throttled.'
  },
  LAMBDA_CODE_STORAGE_EXCEEDED: {
    code: 1303,
    errorCode: 'LAMBDA_CODE_STORAGE_EXCEEDED',
    defaultMessage: 'Lambda code storage quota exceeded.'
  },

  // --- AWS Service Integration: 1400–1499
  S3_BUCKET_NOT_FOUND: {
    code: 1401,
    errorCode: 'S3_BUCKET_NOT_FOUND',
    defaultMessage: 'Specified S3 bucket not found.'
  },
  DYNAMODB_PROVISIONED_THROUGHPUT_EXCEEDED: {
    code: 1402,
    errorCode: 'DYNAMODB_PROVISIONED_THROUGHPUT_EXCEEDED',
    defaultMessage: 'DynamoDB throughput limit exceeded.'
  },

  // --- Third-party Integration: 1500–1599
  THIRD_PARTY_API_ERROR: {
    code: 1501,
    errorCode: 'THIRD_PARTY_API_ERROR',
    defaultMessage: 'External service returned an error.'
  },

  // --- Application Logic: 1600–1699
  BUSINESS_RULE_VIOLATION: {
    code: 1601,
    errorCode: 'BUSINESS_RULE_VIOLATION',
    defaultMessage: 'Operation violates a business rule.'
  },

  // --- System/Internal Errors: 1700–1799
  DATABASE_ERROR: {
    code: 1701,
    errorCode: 'DATABASE_ERROR',
    defaultMessage: 'An internal database error occurred.'
  },

  // --- Rate Limiting & Quotas: 1800–1899
  TOO_MANY_REQUESTS: {
    code: 1801,
    errorCode: 'TOO_MANY_REQUESTS',
    defaultMessage: 'Request rate limit exceeded.'
  },

  // --- Legacy/Project-Specific: 9000–9999
  LEGACY_ERROR: {
    code: 9001,
    errorCode: 'LEGACY_ERROR',
    defaultMessage: 'Legacy system error.'
  }
};

export function buildError(errorKey: keyof typeof ERROR_CODES, customMessage?: string) {
  const base = (ERROR_CODES[errorKey] as ErrorCodeType) || {} as ErrorCodeType;
  return {
    code: base.code || 9999,
    errorCode: base.errorCode || 'UNKNOWN_ERROR',
    message: customMessage || base.defaultMessage || 'Unknown error.'
  };
}
