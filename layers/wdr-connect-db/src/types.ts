/**
 * Type definitions for WDR Database Connection Layer
 */

export interface DatabaseCredentials {
  username: string;
  password: string;
  engine: string;
  host: string;
  port: number;
  dbname: string;
  dbInstanceIdentifier: string;
}

export interface DynamicValue {
  type: 'dynamic_result';
  fromIndex: number;
  field: string;
}

export type OperationValue = any | DynamicValue;

export interface BaseOperation {
  type: 'insert' | 'update' | 'delete' | 'query';
  table?: string;
  returningClause?: string;
}

export interface InsertOperation extends BaseOperation {
  type: 'insert';
  table: string;
  data: Record<string, OperationValue>;
}

export interface UpdateOperation extends BaseOperation {
  type: 'update';
  table: string;
  data: Record<string, OperationValue>;
  condition: Record<string, OperationValue>;
}

export interface DeleteOperation extends BaseOperation {
  type: 'delete';
  table: string;
  condition: Record<string, OperationValue>;
}

export interface QueryOperation extends BaseOperation {
  type: 'query';
  queryText: string;
  params?: OperationValue[];
}

export type Operation = InsertOperation | UpdateOperation | DeleteOperation | QueryOperation;

export interface TransactionResult {
  success: boolean;
  results?: any[][];
  message?: string;
  error?: string;
}

export interface DatabaseResult {
  success: boolean;
  data?: any;
  rowCount?: number;
  error?: any;
  message?: string;
}

export type LogLevel = 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG' | 'CRITICAL';
export type ComponentType = 'JOB' | 'USER' | 'API' | 'DATABASE' | 'SYSTEM';

export interface ErrorLogData {
  level: LogLevel;
  component: ComponentType;
  message: string;
  errorCode?: string | null;
  userId?: string | null;
  ipAddress?: string | null;
  endpoint?: string | null;
  requestData?: any;
  stackTrace?: string | null;
  createdBy?: string | null;
}

export interface LambdaEventInfo {
  userId?: string | null;
  ipAddress?: string | null;
  endpoint?: string | null;
  requestData?: any;
}

export interface CredentialsCacheStatus {
  credentials?: {
    isCached: boolean;
    cachedAt?: number;
    ttl?: number;
    expiresAt?: number;
    isExpired?: boolean;
    timeUntilExpiry?: number;
  };
  iamToken?: {
    isCached: boolean;
    cachedAt?: number;
    ttl?: number;
    expiresAt?: number;
    isExpired?: boolean;
    timeUntilExpiry?: number;
  };
}

export interface DatabaseConfigValidation {
  isValid: boolean;
  source: 'iam-authentication' | 'secrets-manager' | 'environment-variables' | 'error';
  missingFields?: string[];
  error?: string;
}