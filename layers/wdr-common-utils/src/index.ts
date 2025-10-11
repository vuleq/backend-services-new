import { validate as uuidValidate, version as uuidVersion } from 'uuid';
import jwt from 'jsonwebtoken';

// UUID utilities
export const isValidUUID = (uuid: string): boolean => uuidValidate(uuid); // Validates UUID standards (version + variant bits)
export const getUUIDVersion = (uuid: string): number => uuidVersion(uuid);
export const isValidCognitoSub = (sub: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sub); // Format only

// JWT utilities
export const generateToken = (payload: object, secret: string, expiresIn: string = '1h'): string => {
  return jwt.sign(payload, secret, { expiresIn } as jwt.SignOptions);
};

export const verifyToken = (token: string, secret: string): any => {
  try {
    return jwt.verify(token, secret);
  } catch (error) {
    throw new Error(`Token verification failed: ${error}`);
  }
};

export const decodeToken = (token: string): any => {
  return jwt.decode(token, { complete: true });
};

export function getLoginUserInfo(requestHeader: any): { loginUserId: string | null, loginUserName: string | null } {
  let loginUserId = null;
  let loginUserName = null;

  if (requestHeader) {
    let token = requestHeader["Authorization"] || requestHeader["authorization"];
    // Parse JWT token
    if (token) {
      try {
        token = token.replace('Bearer ', '');
        const payload = decodeToken(token)?.payload;
        console.log('JWT Payload received');
        loginUserId = payload?.sub;
        loginUserName = payload?.name;
      } catch (error) {
        console.error('Failed to decode JWT token:', error);
      }
    }
  }
  return { loginUserId, loginUserName };
}

// Date utilities
export const isValidDate = (date: string | Date): boolean => {
  const d = new Date(date);
  return d instanceof Date && !isNaN(d.getTime());
};

export const isDateInRange = (date: string | Date, startDate: string | Date, endDate: string | Date): boolean => {
  const d = new Date(date);
  const start = new Date(startDate);
  const end = new Date(endDate);
  return d >= start && d <= end;
};

export const isValidTime = (time: string): boolean => {
  const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/;
  return timeRegex.test(time);
};

// Validation utilities
export function validateRequiredFields<T>(
  obj: Partial<T>,
  requiredFields: (keyof T)[]
): { isValid: boolean; missingFields: (keyof T)[] } {
  const missingFields = requiredFields.filter(
    field => obj[field] === null || obj[field] === undefined || obj[field] === ''
  );

  return {
    isValid: missingFields.length === 0,
    missingFields
  };
}

export const isValidNumber = (value: any): boolean => {
  return !isNaN(value) && !isNaN(parseFloat(value));
};

export const isValidInteger = (value: any): boolean => {
  return Number.isInteger(Number(value));
};

export const isValidPositiveNumber = (value: any): boolean => {
  return isValidNumber(value) && Number(value) > 0;
};

export const isValidString = (value: any, minLength: number = 1, maxLength: number = Infinity): boolean => {
  return typeof value === 'string' && value.length >= minLength && value.length <= maxLength;
};

export const isValidArray = (value: any, minLength: number = 0): boolean => {
  return Array.isArray(value) && value.length >= minLength;
};

// Schema validation function
export interface ValidationRule {
  required?: boolean;
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'uuid' | 'date' | 'user_uuid';
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: RegExp;
  custom?: (value: any) => boolean;
  message?: string;
}

export interface ValidationSchema {
  [key: string]: ValidationRule;
}

export interface ValidationResult {
  isValid: boolean;
  errors: { field: string; message: string }[];
}

export function validateSchema(data: any, schema: ValidationSchema): ValidationResult {
  const errors: { field: string; message: string }[] = [];

  for (const [field, rule] of Object.entries(schema)) {
    const value = data[field];
    const fieldName = field;

    // Check required
    if (rule.required && (value === null || value === undefined || value === '')) {
      errors.push({ field: fieldName, message: rule.message || `${fieldName} is required` });
      continue;
    }

    // Skip validation if field is not required and empty
    if (!rule.required && (value === null || value === undefined || value === '')) {
      continue;
    }

    // Type validation
    if (rule.type) {
      let isValidType = true;
      switch (rule.type) {
        case 'string':
          isValidType = typeof value === 'string';
          break;
        case 'number':
          isValidType = isValidNumber(value);
          break;
        case 'integer':
          isValidType = isValidInteger(value);
          break;
        case 'boolean':
          isValidType = typeof value === 'boolean';
          break;
        case 'array':
          isValidType = Array.isArray(value);
          break;
        case 'uuid':
          isValidType = typeof value === 'string' && isValidUUID(value);
          break;
        case 'date':
          isValidType = isValidDate(value);
          break;
        case 'user_uuid':
          isValidType = typeof value === 'string' && isValidCognitoSub(value);
          break;
      }
      if (!isValidType) {
        errors.push({ field: fieldName, message: rule.message || `${fieldName} must be a valid ${rule.type}` });
        continue;
      }
    }

    // String length validation
    if (typeof value === 'string') {
      if (rule.minLength !== undefined && value.length < rule.minLength) {
        errors.push({ field: fieldName, message: rule.message || `${fieldName} must be at least ${rule.minLength} characters` });
      }
      if (rule.maxLength !== undefined && value.length > rule.maxLength) {
        errors.push({ field: fieldName, message: rule.message || `${fieldName} must be at most ${rule.maxLength} characters` });
      }
    }

    // Number range validation
    if (isValidNumber(value)) {
      const numValue = Number(value);
      if (rule.min !== undefined && numValue < rule.min) {
        errors.push({ field: fieldName, message: rule.message || `${fieldName} must be at least ${rule.min}` });
      }
      if (rule.max !== undefined && numValue > rule.max) {
        errors.push({ field: fieldName, message: rule.message || `${fieldName} must be at most ${rule.max}` });
      }
    }

    // Pattern validation
    if (rule.pattern && typeof value === 'string' && !rule.pattern.test(value)) {
      errors.push({ field: fieldName, message: rule.message || `${fieldName} format is invalid` });
    }

    // Custom validation
    if (rule.custom && !rule.custom(value)) {
      errors.push({ field: fieldName, message: rule.message || `${fieldName} is invalid` });
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

// AWS Client Configuration utilities
export * from './aws-client-config';

// API/Lambda Models
export * from './common-models';

// Common error codes
export * from './common-error-codes';
