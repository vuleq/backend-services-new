/**
 * WDR Database Connection Layer - Main Entry Point
 * 
 * This layer creates FRESH CONNECTIONS for every operation (no pooling):
 * - Each executeQuery() creates a new database connection
 * - Each transaction creates a new database connection
 * - Connections are closed after each operation
 * - No connection reuse or caching
 * 
 * Authentication hierarchy (for each fresh connection):
 * 1. AWS RDS IAM Authentication (Default - automatic if DB_IAM_USER, DB_HOST, DB_NAME are set)
 * 2. AWS Secrets Manager (Fallback if DB_SECRET_ARN is provided and IAM fails)
 * 3. Environment Variables (Final fallback for development)
 * 
 * For RDS IAM Authentication (Default):
 * - Set DB_IAM_USER, DB_HOST, DB_NAME, DB_PORT environment variables
 * - Ensure Lambda has rds-db:connect permission for the RDS resource
 * - Database user must be created with rds_iam role
 * - SSL connection is automatically enabled for IAM auth
 * 
 * For Secrets Manager fallback:
 * - Set DB_SECRET_ARN environment variable to your secret ARN
 * - Ensure Lambda has secretsmanager:GetSecretValue permission
 * - Secret should contain: username, password, host, port, dbname
 * 
 * For environment variables fallback:
 * - Set: DB_USER, DB_HOST, DB_NAME, DB_PASSWORD, DB_PORT, DB_SSL
 * 
 * Optimization Environment Variables:
 * - DB_CREDENTIALS_TTL: Credentials cache TTL in milliseconds (default: 300000 = 5 minutes)
 * - DB_SECRETS_TIMEOUT: Secrets Manager request timeout in milliseconds (default: 3000 = 3 seconds)
 * - DB_SECRETS_MAX_RETRIES: Maximum retry attempts for Secrets Manager (default: 2)
 * - DB_STATEMENT_TIMEOUT: Database statement timeout in milliseconds (default: 5000)
 * - DB_CONNECTION_TIMEOUT: Fresh connection timeout in milliseconds (default: 10000)
 * - DB_IAM_TOKEN_TTL: IAM token cache TTL in milliseconds (default: 870000 = 14.5 minutes)
 * 
 * Fresh Connection Benefits:
 * - No connection state issues
 * - Fresh credentials on every operation
 * - No connection pool exhaustion
 * - Automatic credential rotation handling
 * - Perfect for Lambda environments
 * - No stale connection problems
 */

// Types
export * from './types.js';

// Connection Management (Fresh connections only - no pooling)
export { 
  clearAllCaches,
  getFreshConnection,
  testConnection
} from './connection-pool.js';

// Database Configuration
export { 
  preloadCredentials, 
  validateDatabaseConfig 
} from './database-config.js';

// Basic Database Operations
export { 
  executeQuery, 
  insertRecord, 
  updateRecord, 
  deleteRecord
} from './database-operations.js';

// Transaction Operations
export { performTransaction } from './transactions.js';

// Error Logging
export {
  logError,
  logCritical,
  logAPIError,
  logDatabaseError,
  logUserAction,
  logJobError,
  logWarning,
  logDebug,
  withErrorLogging,
  extractLambdaEventInfo,
  getRecentErrors
} from './error-logging.js';

// Secrets Manager
export {
  refreshSecretsManagerClient,
  getCredentialsCacheStatus as getSecretsCredentialsCacheStatus,
  refreshCredentials as refreshSecretsCredentials,
  clearCredentialsCache
} from './secrets-manager.js';

// IAM Authentication
export {
  getIAMTokenCacheStatus,
  refreshIAMToken,
  hasIAMAuthRequirements
} from './iam-auth.js';

// Combined cache status utility
export function getCredentialsCacheStatus() {
  // Import at runtime to avoid circular dependencies
  const { getCredentialsCacheStatus: getSecretsStatus } = require('./secrets-manager.js');
  const { getIAMTokenCacheStatus } = require('./iam-auth.js');
  
  return {
    credentials: getSecretsStatus(),
    iamToken: getIAMTokenCacheStatus()
  };
}

// Combined refresh utility
export async function refreshCredentials(): Promise<boolean> {
  // Import at runtime to avoid circular dependencies
  const { hasIAMAuthRequirements, refreshIAMToken } = require('./iam-auth.js');
  const { refreshCredentials: refreshSecretsCredentials } = require('./secrets-manager.js');
  
  const hasIAMRequirements = hasIAMAuthRequirements();
  
  try {
    if (hasIAMRequirements) {
      // Try to refresh IAM token first (default method)
      return await refreshIAMToken();
    } else if (process.env.DB_SECRET_ARN) {
      // Refresh Secrets Manager credentials
      return await refreshSecretsCredentials();
    } else {
      console.log('Using environment variables - no refresh needed');
      return true;
    }
  } catch (error: any) {
    console.error('Failed to refresh credentials:', error.message || error);
    return false;
  }
}