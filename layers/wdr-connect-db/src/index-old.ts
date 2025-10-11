/**
 * WDR Database Connection Layer
 * 
 * This layer uses AWS RDS IAM Authentication by default with automatic fallback:
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
 * - DB_STATEMENT_TIMEOUT: Database statement timeout in milliseconds (default: 2000)
 * - DB_IAM_TOKEN_TTL: IAM token cache TTL in milliseconds (default: 870000 = 14.5 minutes)
 * 
 * Performance Tips:
 * - Call preloadCredentials() early in Lambda handler to reduce cold start impact
 * - Use appropriate TTL based on your credential rotation schedule
 * - Monitor timeout logs to adjust timeout values for your network conditions
 * - IAM tokens are valid for 15 minutes, cached for 14.5 minutes to ensure validity
 */

import { Pool, PoolConfig } from 'pg';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { Signer } from "@aws-sdk/rds-signer";
import { Agent as HttpsAgent } from 'https';

interface DatabaseCredentials {
  username: string;
  password: string;
  engine: string;
  host: string;
  port: number;
  dbname: string;
  dbInstanceIdentifier: string;
}

interface CachedCredentials {
  credentials: DatabaseCredentials;
  cachedAt: number;
  ttl: number; // in milliseconds
}

interface CachedIAMToken {
  token: string;
  cachedAt: number;
  ttl: number; // in milliseconds
}

let isPoolInitialized = false;
let pool: Pool;
let cachedCredentials: CachedCredentials | null = null;
let cachedIAMToken: CachedIAMToken | null = null;

// Configuration optimized for 30-second Lambda timeout
const SECRET_NAME = process.env.DB_SECRET_ARN || "rds-db-credentials/cluster-SUDETH5ZXZOFLLIXDRLOHWXVRQ/postgre/1754619987257";
const CREDENTIALS_TTL = parseInt(process.env.DB_CREDENTIALS_TTL || '300000'); // 5 minutes default
const SECRETS_TIMEOUT = parseInt(process.env.DB_SECRETS_TIMEOUT || '20000'); // Increased to 20 seconds
const MAX_RETRIES = parseInt(process.env.DB_SECRETS_MAX_RETRIES || '15'); // Increased to 3 retries
const IAM_TOKEN_TTL = parseInt(process.env.DB_IAM_TOKEN_TTL || '870000'); // 14.5 minutes default (IAM tokens valid for 15 min)

// Debug logging for timeout configuration
console.log(`Secrets Manager Configuration: timeout=${SECRETS_TIMEOUT}ms, retries=${MAX_RETRIES}, region=${process.env.AWS_REGION || "ap-southeast-1"}`);

// Track Lambda execution context to detect container reuse
let lastExecutionTime = 0;
let secretsClientInstance: SecretsManagerClient | null = null;

/**
 * Create a fresh SecretsManagerClient instance
 * This helps avoid stale connection issues during Lambda freeze/thaw cycles
 */
function createSecretsClient(): SecretsManagerClient {
  console.log('Creating fresh SecretsManagerClient instance...');
  
  return new SecretsManagerClient({
    region: process.env.AWS_REGION || "ap-southeast-1",
    requestHandler: {
      requestTimeout: SECRETS_TIMEOUT,
      connectionTimeout: 7000, 
      httpsAgent: new HttpsAgent({
        keepAlive: false, // Keep alive for warm start performance
        keepAliveMsecs: 5000,
        maxSockets: 200,
        maxFreeSockets: 10,
        timeout: SECRETS_TIMEOUT + 2000,
        scheduling: 'fifo'
      })
    },
    maxAttempts: MAX_RETRIES,
    retryMode: "adaptive"
  });
}

/**
 * Get or create SecretsManager client with intelligent connection management
 * - Reuses connections during warm starts (< 30s gap)
 * - Creates fresh client after potential freeze/thaw (> 30s gap)
 * - Forces fresh client after connection errors
 */
function getSecretsClient(): SecretsManagerClient {
  const now = Date.now();
  const timeSinceLastExecution = now - lastExecutionTime;
  
  // If more than 10 seconds since last use, likely a freeze/thaw cycle
  // Create fresh client to avoid stale connections
  if (!secretsClientInstance || timeSinceLastExecution > 5000) {
    if (secretsClientInstance && timeSinceLastExecution > 5000) {
      console.log(`Creating fresh client due to ${Math.round(timeSinceLastExecution/1000)}s gap (possible freeze/thaw)`);
    }
    secretsClientInstance = createSecretsClient();
  } else {
    // Warm start - reuse existing client for performance
    console.log(`Reusing existing client (warm start: ${timeSinceLastExecution}ms gap)`);
  }
  
  lastExecutionTime = now;
  return secretsClientInstance;
}

/**
 * Force refresh of the SecretsManager client (for testing or after errors)
 */
export function refreshSecretsManagerClient(): void {
  console.log('Forcing refresh of SecretsManager client...');
  secretsClientInstance = null;
  lastExecutionTime = 0;
}

async function getIAMAuthToken(): Promise<string> {
  // Check if we have valid cached IAM token
  if (cachedIAMToken) {
    const now = Date.now();
    const isExpired = (now - cachedIAMToken.cachedAt) > cachedIAMToken.ttl;
    
    if (!isExpired) {
      console.log('Using cached IAM authentication token');
      return cachedIAMToken.token;
    } else {
      console.log('Cached IAM token expired, generating new one...');
      cachedIAMToken = null;
    }
  }

  try {
    console.log('Generating new IAM authentication token for RDS...');
    
    const hostname = process.env.DB_HOST;
    const port = parseInt(process.env.DB_PORT || '5432', 10);
    const username = process.env.DB_IAM_USER;
    
    console.log(`IAM Auth Details - Host: ${hostname}, Port: ${port}, Username: ${username}, Region: ${process.env.AWS_REGION || "ap-southeast-1"}`);

    if (!hostname || !username) {
      throw new Error('DB_HOST and DB_IAM_USER environment variables are required for IAM authentication');
    }

    const rdsSigner = new Signer({
      hostname,
      port,
      username,
      region: process.env.AWS_REGION || "ap-southeast-1",
    });

    const token = await rdsSigner.getAuthToken();

    // Cache the token with TTL (14.5 minutes to ensure it's valid when used)
    cachedIAMToken = {
      token,
      cachedAt: Date.now(),
      ttl: IAM_TOKEN_TTL
    };

    console.log(`IAM authentication token generated and cached successfully (TTL: ${IAM_TOKEN_TTL}ms)`);
    return token;
  } catch (error: any) {
    console.error('Error generating IAM authentication token:', error);
    
    // If we have expired cached token and generation fails, try using it
    if (cachedIAMToken && cachedIAMToken.token) {
      console.warn('Using expired cached IAM token due to generation failure');
      return cachedIAMToken.token;
    }
    
    throw error;
  }
}

async function getSecretsManagerCredentials(): Promise<DatabaseCredentials> {
  // Check if we have valid cached credentials
  if (cachedCredentials) {
    const now = Date.now();
    const isExpired = (now - cachedCredentials.cachedAt) > cachedCredentials.ttl;
    
    if (!isExpired) {
      console.log('Using cached database credentials from Secrets Manager');
      return cachedCredentials.credentials;
    } else {
      console.log('Cached credentials expired, fetching new ones...');
      cachedCredentials = null;
    }
  }

  let lastError: any;
  
  // Try up to 2 times: first with existing client, then with fresh client if connection issues
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`Fetching database credentials from Secrets Manager... (attempt ${attempt}, timeout: ${SECRETS_TIMEOUT}ms)`);
      const startTime = Date.now();
      
      // Get client instance (fresh on retry after connection error)
      const secretsClient = getSecretsClient();
      
      // Create a timeout promise to race against the Secrets Manager call
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Secrets Manager request timed out after ${SECRETS_TIMEOUT}ms`));
        }, SECRETS_TIMEOUT + 1000); // Add 1 second buffer to the client timeout
      });

      // Race the Secrets Manager call against the timeout
      const secretsPromise = secretsClient.send(
        new GetSecretValueCommand({
          SecretId: SECRET_NAME,
          VersionStage: "AWSCURRENT",
        })
      );

      const response = await Promise.race([secretsPromise, timeoutPromise]);
      const elapsedTime = Date.now() - startTime;
      console.log(`Secrets Manager request completed in ${elapsedTime}ms (attempt ${attempt})`);

      if (!response.SecretString) {
        throw new Error('No secret string found in Secrets Manager response');
      }

      const credentials: DatabaseCredentials = JSON.parse(response.SecretString);
      
      // Cache the credentials with TTL
      cachedCredentials = {
        credentials,
        cachedAt: Date.now(),
        ttl: CREDENTIALS_TTL
      };
      
      console.log(`Database credentials retrieved and cached successfully (TTL: ${CREDENTIALS_TTL}ms)`);
      return credentials;
      
    } catch (error: any) {
      lastError = error;
      
      const errorDetails = {
        attempt,
        name: error.name,
        code: error.code,
        message: error.message,
        timeout: SECRETS_TIMEOUT,
        region: process.env.AWS_REGION || "ap-southeast-1"
      };
      console.error('Error retrieving credentials from Secrets Manager:', errorDetails);
      
      // Check if this looks like a stale connection issue
      const isConnectionError = error.name === 'TimeoutError' || 
                              error.code === 'ECONNRESET' || 
                              error.code === 'ENOTFOUND' ||
                              error.code === 'EPIPE' ||
                              error.message?.includes('timeout') ||
                              error.message?.includes('connect') ||
                              error.message?.includes('socket');
      
      if (isConnectionError && attempt === 1) {
        console.log('Connection error detected, forcing fresh client for retry...');
        secretsClientInstance = null; // Force fresh client creation
        continue; // Retry with fresh client
      }
      
      // If not a connection error or already retried, break the loop
      break;
    }
  }
  
  // If we get here, both attempts failed
  console.error('All attempts to retrieve credentials failed');
  
  // If we have expired cached credentials and Secrets Manager fails, use them temporarily
  if (cachedCredentials && cachedCredentials.credentials) {
    console.warn('Using expired cached credentials due to Secrets Manager failure');
    return cachedCredentials.credentials;
  }
  
  // If no cached credentials available, throw error to trigger fallback to environment variables
  console.warn('No cached credentials available, will fallback to environment variables');
  throw lastError;
}

async function getDbConfig(): Promise<PoolConfig> {
  // Try RDS IAM Authentication first (default method)
  // Check if we have the required environment variables for IAM auth
  // const hasIAMRequirements = process.env.DB_IAM_USER && process.env.DB_HOST && process.env.DB_NAME;
  
  // if (hasIAMRequirements) {
  //   try {
  //     console.log('Using RDS IAM authentication for database connection (default method)');
      
  //     const token = await getIAMAuthToken();
  //     console.log(`IAM token generated successfully. Token length: ${token.length}, starts with: ${token.substring(0, 20)}...`);
      
  //     const config = {
  //       user: process.env.DB_IAM_USER!,
  //       host: process.env.DB_HOST!,
  //       database: process.env.DB_NAME!,
  //       password: token,
  //       port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
  //       max: 10,
  //       idleTimeoutMillis: 30000,
  //       connectionTimeoutMillis: 2000,
  //       ssl: {
  //         rejectUnauthorized: false // Required for RDS IAM authentication in Lambda
  //       }
  //     };
      
  //     console.log(`Connection config - User: ${config.user}, Host: ${config.host}, Database: ${config.database}, Port: ${config.port}, SSL: ${config.ssl}`);
  //     return config;
  //   } catch (error: any) {
  //     console.warn('Failed to configure IAM authentication, falling back to Secrets Manager or environment variables:', error.message || error);
      
  //     // Log the IAM failure for monitoring
  //     try {
  //       if (typeof logWarning === 'function') {
  //         await logWarning('IAM authentication fallback to alternative methods', {
  //           component: 'DATABASE',
  //           errorCode: 'IAM_AUTH_FAILED',
  //           stackTrace: error.stack
  //         });
  //       }
  //     } catch (logError) {
  //       console.warn('Failed to log IAM authentication fallback error:', logError);
  //     }
      
  //     // Continue to try other methods
  //   }
  // } else {
  //   console.log('IAM authentication requirements not met (missing DB_IAM_USER, DB_HOST, or DB_NAME), trying alternative methods');
  // }
  
  // Try to use Secrets Manager if DB_SECRET_ARN is provided
  if (process.env.DB_SECRET_ARN) {
    try {
      // Wrap the entire Secrets Manager operation with a timeout
      const credentials = await Promise.race([
        getSecretsManagerCredentials(),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Database configuration retrieval timed out after ${SECRETS_TIMEOUT + 1000}ms`));
          }, SECRETS_TIMEOUT + 1000); // Allow extra time for retries
        })
      ]);

      console.log('Successfully retrieved credentials from Secrets Manager');
      return {
        user: credentials.username,
        host: credentials.host,
        database: credentials.dbname,
        password: credentials.password,
        port: credentials.port,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
      };
    } catch (error: any) {
      console.warn('Failed to get credentials from Secrets Manager, falling back to environment variables.', error.message || error);
      
      // Log the error for monitoring but don't fail the entire operation
      try {
        if (typeof logWarning === 'function') {
          await logWarning('Secrets Manager fallback to environment variables', {
            component: 'DATABASE',
            errorCode: 'SECRETS_MANAGER_TIMEOUT',
            stackTrace: error.stack
          });
        }
      } catch (logError) {
        // Don't let logging errors break the flow
        console.warn('Failed to log Secrets Manager fallback error:', logError);
      }
      
      // Continue to fallback
    }
  }

  // Fallback to environment variables
  console.log('Using environment variables for database configuration (final fallback)');
  
  // For environment variable fallback, use the password-based user
  const envUser = process.env.DB_USER;
  const requiredEnvVars = ['DB_HOST', 'DB_NAME', 'DB_PASSWORD'];
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  
  if (!envUser) {
    missingVars.push('DB_USER');
  }
  
  if (missingVars.length > 0) {
    const errorMsg = `Missing required environment variables: ${missingVars.join(', ')}. Please set these variables for environment-based authentication, or configure DB_SECRET_ARN for Secrets Manager, or ensure IAM authentication requirements are met.`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  return {
    user: envUser!,
    host: process.env.DB_HOST!,
    database: process.env.DB_NAME!,
    password: process.env.DB_PASSWORD!,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
  };
}

async function initializePool(): Promise<void> {
  if (!pool) {
    const dbConfig = await getDbConfig();
    pool = new Pool(dbConfig);
    
    pool.on('error', (err: Error) => {
      console.error('Unexpected error on idle client', err);
      isPoolInitialized = false;
      
      // Clear cached credentials on specific authentication errors to force refresh
      if (err.message && (
        err.message.includes('authentication') || 
        err.message.includes('password') ||
        err.message.includes('SASL') ||
        err.message.includes('credentials') ||
        err.message.includes('IAM')
      )) {
        console.log('Authentication error detected, clearing cached credentials and IAM tokens');
        cachedCredentials = null;
        cachedIAMToken = null;
      }
    });

    // Add connection event listeners for better monitoring
    pool.on('connect', () => {
      console.log('Database client connected');
    });

    pool.on('remove', () => {
      console.log('Database client removed');
    });
  }
}

/**
 * Preload database credentials during Lambda cold start
 * Call this function early in your Lambda handler to reduce latency
 * This function is designed to NEVER break your application - it always returns gracefully
 */
export async function preloadCredentials(): Promise<boolean> {
  // const hasIAMRequirements = process.env.DB_IAM_USER && process.env.DB_HOST && process.env.DB_NAME;
  
  // // // Try IAM authentication first (default method)
  // if (hasIAMRequirements) {
  //   try {
  //     await getIAMAuthToken();
  //     console.log('IAM authentication token preloaded successfully (default method)');
  //     return true;
  //   } catch (error: any) {
  //     console.warn('Failed to preload IAM authentication token, will try alternative methods:', error.message || error);
  //     // Continue to try other methods instead of returning false
  //   }
  // }
  
  // // Try Secrets Manager if available
  if (process.env.DB_SECRET_ARN) {
    try {
      await getSecretsManagerCredentials();
      console.log('Database credentials preloaded successfully from Secrets Manager');
      return true;
    } catch (error: any) {
      console.warn('Failed to preload credentials from Secrets Manager:', error.message || error);
      
      // Check if environment variables are available as fallback
      const envUser = process.env.DB_PASSWORD_USER || process.env.DB_USER;
      const hasEnvVars = envUser && process.env.DB_HOST && process.env.DB_NAME && process.env.DB_PASSWORD;
      if (hasEnvVars) {
        console.log('Environment variables available as fallback for database connection');
        return true; // Fallback is available
      } else {
        console.error('No fallback environment variables available. Database connection may fail.');
        return false; // No fallback available
      }
    }
  }
  
  // Check if environment variables are available
  const envUser = process.env.DB_USER;
  const hasEnvVars = envUser && process.env.DB_HOST && process.env.DB_NAME && process.env.DB_PASSWORD;
  if (hasEnvVars) {
    console.log('Environment variables available for database connection');
    return true;
  }
  
  console.error('No valid database authentication method available. Please configure IAM authentication, Secrets Manager, or environment variables.');
  return false;
}

export async function ensureConnection(): Promise<boolean> {
  if (!isPoolInitialized) {
    try {
      await initializePool();
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      isPoolInitialized = true;
      console.log('Database connection established successfully');
    } catch (err: any) {
      console.error('Failed to establish database connection:', err);
      isPoolInitialized = false;
      
      // Clear cached credentials on connection failure that might be auth-related
      if (err.message && (
        err.message.includes('authentication') || 
        err.message.includes('password') ||
        err.message.includes('SASL') ||
        err.message.includes('credentials') ||
        err.message.includes('IAM')
      )) {
        console.log('Authentication error detected, clearing cached credentials and IAM tokens for retry');
        cachedCredentials = null;
        cachedIAMToken = null;
      }
      
      // Reset pool to allow retry with fresh configuration
      const dbConfig = await getDbConfig();
      pool = new Pool(dbConfig);
      throw err;
    }
  }
  return isPoolInitialized;
}

/**
 * Get credentials cache status for monitoring and debugging
 */
export function getCredentialsCacheStatus(): {
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
} {
  const result: any = {};

  // Credentials cache status
  if (!cachedCredentials) {
    result.credentials = { isCached: false };
  } else {
    const now = Date.now();
    const expiresAt = cachedCredentials.cachedAt + cachedCredentials.ttl;
    const isExpired = now > expiresAt;
    const timeUntilExpiry = Math.max(0, expiresAt - now);

    result.credentials = {
      isCached: true,
      cachedAt: cachedCredentials.cachedAt,
      ttl: cachedCredentials.ttl,
      expiresAt,
      isExpired,
      timeUntilExpiry
    };
  }

  // IAM token cache status
  if (!cachedIAMToken) {
    result.iamToken = { isCached: false };
  } else {
    const now = Date.now();
    const expiresAt = cachedIAMToken.cachedAt + cachedIAMToken.ttl;
    const isExpired = now > expiresAt;
    const timeUntilExpiry = Math.max(0, expiresAt - now);

    result.iamToken = {
      isCached: true,
      cachedAt: cachedIAMToken.cachedAt,
      ttl: cachedIAMToken.ttl,
      expiresAt,
      isExpired,
      timeUntilExpiry
    };
  }

  return result;
}

/**
 * Validate database configuration without connecting
 * Useful for health checks and debugging
 */
export async function validateDatabaseConfig(): Promise<{
  isValid: boolean;
  source: 'iam-authentication' | 'secrets-manager' | 'environment-variables' | 'error';
  missingFields?: string[];
  error?: string;
}> {
  try {
    // Try to get the configuration
    const config = await getDbConfig();
    
    // Check for missing required fields
    const requiredFields = ['user', 'host', 'database', 'password'];
    const missingFields = requiredFields.filter(field => !config[field as keyof PoolConfig]);
    
    if (missingFields.length > 0) {
      return {
        isValid: false,
        source: 'error',
        missingFields,
        error: `Missing required database configuration fields: ${missingFields.join(', ')}`
      };
    }
    
    // Determine the source based on what was actually used
    const hasIAMRequirements = process.env.DB_IAM_USER && process.env.DB_HOST && process.env.DB_NAME;
    let source: 'iam-authentication' | 'secrets-manager' | 'environment-variables';
    
    if (hasIAMRequirements && cachedIAMToken) {
      source = 'iam-authentication';
    } else if (process.env.DB_SECRET_ARN && cachedCredentials) {
      source = 'secrets-manager';
    } else {
      source = 'environment-variables';
    }
    
    return {
      isValid: true,
      source
    };
    
  } catch (error: any) {
    return {
      isValid: false,
      source: 'error',
      error: error.message || 'Unknown configuration error'
    };
  }
}

/**
 * Force refresh of cached credentials (useful for testing or manual refresh)
 */
export async function refreshCredentials(): Promise<boolean> {
  const hasIAMRequirements = process.env.DB_IAM_USER && process.env.DB_HOST && process.env.DB_NAME;
  
  try {
    if (hasIAMRequirements) {
      // Try to refresh IAM token first (default method)
      cachedIAMToken = null;
      await getIAMAuthToken();
      console.log('IAM authentication token refreshed successfully (default method)');
      return true;
    } else if (process.env.DB_SECRET_ARN) {
      // Refresh Secrets Manager credentials
      cachedCredentials = null;
      await getSecretsManagerCredentials();
      console.log('Secrets Manager credentials refreshed successfully');
      return true;
    } else {
      console.log('Using environment variables - no refresh needed');
      return true;
    }
  } catch (error: any) {
    console.error('Failed to refresh credentials:', error.message || error);
    return false;
  }
}

/**
 * Get IAM token cache status specifically
 */
export function getIAMTokenCacheStatus(): {
  isCached: boolean;
  cachedAt?: number;
  ttl?: number;
  expiresAt?: number;
  isExpired?: boolean;
  timeUntilExpiry?: number;
} {
  if (!cachedIAMToken) {
    return { isCached: false };
  }

  const now = Date.now();
  const expiresAt = cachedIAMToken.cachedAt + cachedIAMToken.ttl;
  const isExpired = now > expiresAt;
  const timeUntilExpiry = Math.max(0, expiresAt - now);

  return {
    isCached: true,
    cachedAt: cachedIAMToken.cachedAt,
    ttl: cachedIAMToken.ttl,
    expiresAt,
    isExpired,
    timeUntilExpiry
  };
}

/**
 * Force refresh of IAM authentication token
 */
export async function refreshIAMToken(): Promise<boolean> {
  try {
    cachedIAMToken = null;
    await getIAMAuthToken();
    console.log('IAM authentication token refreshed successfully');
    return true;
  } catch (error: any) {
    console.error('Failed to refresh IAM token:', error.message || error);
    return false;
  }
}

export async function closePool(): Promise<void> {
  try {
    await pool.end();
    console.log('Database connection pool closed');
    isPoolInitialized = false;
  } catch (err) {
    console.error('Error closing database pool:', err);
  }
}

function validateTableName(tableName: string): string {
  if (!tableName || typeof tableName !== 'string' || /[^a-zA-Z0-9_]/.test(tableName)) {
    throw new Error('Invalid table name');
  }
  return tableName;
}

export async function executeQuery(queryText: string, params: any[] = []): Promise<{ success: boolean; data?: any; rowCount?: number; error?: any }> {
  let client;
  try {
    await ensureConnection();
    client = await pool.connect();
    const queryConfig = {
      text: queryText,
      values: params,
      statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT || '2000')
    };
    const result = await client.query(queryConfig);
    return { success: true, data: result.rows, rowCount: result.rowCount === null ? undefined : result.rowCount };
  } catch (err: any) {
    console.error('Error executing query:', err.message || err);
    return { success: false, error: err.message || err };
  } finally {
    if (client) {
      client.release();
    }
  }
}

export async function insertRecord(tableName: string, data: Record<string, any>, returningClause = '*') {
  try {
    tableName = validateTableName(tableName);
    const columns = Object.keys(data);
    const values = Object.values(data);
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    const queryText = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING ${returningClause};`;
    const result = await executeQuery(queryText, values);
    if (result.success && result.data && result.data.length > 0) {
      return { success: true, data: result.data[0], rowCount: result.rowCount };
    } else if (result.success) {
      return { success: true, message: 'Record inserted, but no data returned from RETURNING clause.' };
    } else {
      return result;
    }
  } catch (err: any) {
    console.error('Error in insertRecord:', err);
    return { success: false, error: err.message || err };
  }
}

export async function updateRecord(tableName: string, data: Record<string, any>, condition: Record<string, any>, returningClause = '*') {
  try {
    tableName = validateTableName(tableName);
    const setClauses = Object.keys(data).map((key, index) => `${key} = $${index + 1}`).join(', ');
    const setValues = Object.values(data);
    const conditionClauses = Object.keys(condition).map((key, index) => `${key} = $${setValues.length + index + 1}`).join(' AND ');
    const conditionValues = Object.values(condition);
    const allValues = [...setValues, ...conditionValues];
    const queryText = `UPDATE ${tableName} SET ${setClauses} WHERE ${conditionClauses}${returningClause ? ` RETURNING ${returningClause}` : ''};`;
    const result = await executeQuery(queryText, allValues);
    if (returningClause && result.success && result.data && result.data.length > 0) {
      return { success: true, data: result.data, rowCount: result.rowCount };
    } else {
      return { success: true, rowCount: result.rowCount };
    }
  } catch (err: any) {
    console.error('Error in updateRecord:', err);
    return { success: false, error: err.message || err };
  }
}

export async function deleteRecord(tableName: string, condition: Record<string, any>, returningClause = '') {
  try {
    tableName = validateTableName(tableName);
    const conditionClauses = Object.keys(condition).map((key, index) => `${key} = $${index + 1}`).join(' AND ');
    const conditionValues = Object.values(condition);
    const queryText = `DELETE FROM ${tableName} WHERE ${conditionClauses}${returningClause ? ` RETURNING ${returningClause}` : ''};`;
    const result = await executeQuery(queryText, conditionValues);
    if (returningClause && result.success && result.data && result.data.length > 0) {
      return { success: true, data: result.data, rowCount: result.rowCount };
    } else {
      return { success: true, rowCount: result.rowCount };
    }
  } catch (err: any) {
    console.error('Error in deleteRecord:', err);
    return { success: false, error: err.message || err };
  }
}

export interface DynamicValue {
  type: 'dynamic_result';
  fromIndex: number;
  field: string;
}

type OperationValue = any | DynamicValue;

// Helper function to resolve dynamic values from previous operation results
function resolveDynamicValue(value: OperationValue, allPreviousResults: any[][]): any {
    if (value && typeof value === 'object' && value.type === 'dynamic_result' && typeof value.fromIndex === 'number' && value.field) {
        const prevOpResult = allPreviousResults[value.fromIndex];
        if (prevOpResult && prevOpResult.length > 0) {
            return prevOpResult[0][value.field];
        } else {
            console.warn(`Dynamic value resolution: No result found at index ${value.fromIndex} or field '${value.field}' is missing.`);
            throw new Error(`Transaction dependency error: Could not resolve dynamic value from operation ${value.fromIndex} for field '${value.field}'.`);
        }
    }
    return value;
}

interface BaseOperation {
  type: 'insert' | 'update' | 'delete' | 'query';
  table?: string;
  returningClause?: string;
}

interface InsertOperation extends BaseOperation {
  type: 'insert';
  table: string;
  data: Record<string, OperationValue>;
}

interface UpdateOperation extends BaseOperation {
  type: 'update';
  table: string;
  data: Record<string, OperationValue>;
  condition: Record<string, OperationValue>;
}

interface DeleteOperation extends BaseOperation {
  type: 'delete';
  table: string;
  condition: Record<string, OperationValue>;
}

interface QueryOperation extends BaseOperation {
  type: 'query';
  queryText: string;
  params?: OperationValue[];
}

export type Operation = InsertOperation | UpdateOperation | DeleteOperation | QueryOperation;

interface TransactionResult {
  success: boolean;
  results?: any[][];
  message?: string;
  error?: string;
}

/**
 * Executes multiple database operations in a single transaction with dynamic value resolution.
 * 
 * Dynamic values: Reference previous operation results using:
 *   { type: 'dynamic_result', fromIndex: 0, field: 'id' }
 */
export async function performTransaction(operations: Operation[]): Promise<TransactionResult> {
    let client;
    // `allOperationResults` will store the full `result.rows` for each operation
    // This allows `resolveDynamicValue` to look up any previous result.
    const allOperationResults: any[][] = [];

    try {
        await ensureConnection(); // Ensure connection pool is ready
        
        client = await pool.connect(); // Get a dedicated client for the transaction
        await client.query('BEGIN'); // Start the transaction

        for (let i = 0; i < operations.length; i++) {
            const op = operations[i];
            let queryText: string;
            let values: any[];
            let result: any;

            if (op.table) {
                op.table = validateTableName(op.table);
            }

            // Resolve dynamic values in data and condition
            const resolvedData: Record<string, any> = {};
            if ('data' in op && op.data) {
                for (const key in op.data) {
                    resolvedData[key] = resolveDynamicValue(op.data[key], allOperationResults);
                }
            }

            const resolvedCondition: Record<string, any> = {};
            if ('condition' in op && op.condition) {
                for (const key in op.condition) {
                    resolvedCondition[key] = resolveDynamicValue(op.condition[key], allOperationResults);
                }
            }

            if (op.type === 'insert') {
                const columns = Object.keys(resolvedData);
                values = Object.values(resolvedData);
                const placeholders = columns.map((col, index) => `$${index + 1}`).join(', ');
                const returningClause = op.returningClause || '';

                queryText = `INSERT INTO ${op.table} (${columns.join(', ')}) VALUES (${placeholders})${returningClause ? ` RETURNING ${returningClause}` : ''};`;

                const queryConfig = {
                    text: queryText,
                    values: values,
                    statement_timeout: 25000 // 25 seconds
                };

                result = await client.query(queryConfig);

                // Store full result.rows for dynamic lookups in subsequent operations
                if (result.rows) {
                    allOperationResults[i] = result.rows;
                }

            } else if (op.type === 'update') {
                const setClauses = Object.keys(resolvedData).map((key, index) => `${key} = $${index + 1}`).join(', ');
                const setValues = Object.values(resolvedData);

                const conditionClauses = Object.keys(resolvedCondition).map((key, index) => `${key} = $${setValues.length + index + 1}`).join(' AND ');
                const conditionValues = Object.values(resolvedCondition);

                values = [...setValues, ...conditionValues];
                const returningClause = op.returningClause || '';

                queryText = `UPDATE ${op.table} SET ${setClauses} WHERE ${conditionClauses}${returningClause ? ` RETURNING ${returningClause}` : ''};`;

                const queryConfig = {
                    text: queryText,
                    values: values,
                    statement_timeout: 25000
                };

                result = await client.query(queryConfig);

                if (result.rows) {
                    allOperationResults[i] = result.rows;
                }

            } else if (op.type === 'delete') {
                const conditionClauses = Object.keys(resolvedCondition).map((key, index) => `${key} = $${index + 1}`).join(' AND ');
                values = Object.values(resolvedCondition);
                const returningClause = op.returningClause || '';

                queryText = `DELETE FROM ${op.table} WHERE ${conditionClauses}${returningClause ? ` RETURNING ${returningClause}` : ''};`;

                const queryConfig = {
                    text: queryText,
                    values: values,
                    statement_timeout: 25000
                };

                result = await client.query(queryConfig);

                if (result.rows) {
                    allOperationResults[i] = result.rows;
                }

            } else if (op.type === 'query') {
                const resolvedParams = (op.params || []).map(param => resolveDynamicValue(param, allOperationResults));

                const queryConfig = {
                    text: op.queryText,
                    values: resolvedParams,
                    statement_timeout: 25000
                };

                result = await client.query(queryConfig);

                if (result.rows) {
                    allOperationResults[i] = result.rows;
                }

            } else {
                throw new Error(`Unsupported operation type: ${(op as any).type}`);
            }
        }

        await client.query('COMMIT');
        return { success: true, results: allOperationResults, message: "Transaction completed successfully." };

    } catch (err: any) {
        if (client) {
            try {
                await client.query('ROLLBACK');
                console.error('Transaction rolled back successfully.');
            } catch (rollbackErr) {
                console.error('Error during transaction rollback:', rollbackErr);
            }
        }
        console.error('Error during transaction:', err.message || err);
        return { success: false, error: err.message || err };
    } finally {
        if (client) {
            client.release();
        }
    }
}

// ==========================================
// START ERROR LOGGING FUNCTIONALITY
// ==========================================

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

/**
 * Extract common info from AWS Lambda event for error logging
 */
export function extractLambdaEventInfo(event: any, context?: any): LambdaEventInfo {
  const requestContext = event?.requestContext || {};
  return {
    userId: event?.requestContext?.authorizer?.userId || 
             event?.requestContext?.authorizer?.claims?.sub ||
             null,
    ipAddress: requestContext?.identity?.sourceIp || null,
    endpoint: requestContext?.httpMethod && requestContext?.path 
              ? `${requestContext.httpMethod} ${requestContext.path}` 
              : null,
    requestData: {
      headers: event?.headers || {},
      queryStringParameters: event?.queryStringParameters || {},
      pathParameters: event?.pathParameters || {},
      body: event?.body ? (typeof event.body === 'string' ? JSON.parse(event.body) : event.body) : null
    }
  };
}

/**
 * Log error to database using existing connection pool
 * Falls back to console.error if database logging fails
 */
export async function logError(data: ErrorLogData): Promise<{ success: boolean; errorId?: string; error?: any }> {
  try {
    const logData = {
      level: data.level,
      component: data.component,
      message: data.message,
      error_code: data.errorCode || null,
      user_id: data.userId || null,
      ip_address: data.ipAddress || null,
      endpoint: data.endpoint || null,
      request_data: data.requestData ? JSON.stringify(data.requestData) : null,
      stack_trace: data.stackTrace || null,
      created_by: data.createdBy || null
    };

    const result = await insertRecord('error_logs', logData, 'id, created_at');
    
    if (result.success) {
      // Check if result has data property and it's not empty
      if ('data' in result && result.data) {
        return { 
          success: true, 
          errorId: result.data.id 
        };
      } else {
        // Handle case where insertion succeeded but no data returned
        return { success: true };
      }
    } else {
      // Fallback to console if insert failed
      const errorMessage = 'error' in result ? result.error : 'Unknown database error';
      console.error('Database error logging failed:', errorMessage);
      console.error('Original error data:', data);
      return { success: false, error: errorMessage };
    }
  } catch (err: any) {
    // Fallback to console if everything fails
    console.error('Critical error: Failed to log error to database:', err);
    console.error('Original error data:', data);
    return { success: false, error: err.message || err };
  }
}

/**
 * Convenience methods for different log levels
 */
export async function logCritical(message: string, details: Partial<ErrorLogData> = {}) {
  return logError({ level: 'CRITICAL', component: 'SYSTEM', message, ...details });
}

export async function logAPIError(message: string, details: Partial<ErrorLogData> = {}) {
  return logError({ level: 'ERROR', component: 'API', message, ...details });
}

export async function logDatabaseError(message: string, details: Partial<ErrorLogData> = {}) {
  return logError({ level: 'ERROR', component: 'DATABASE', message, ...details });
}

export async function logUserAction(message: string, details: Partial<ErrorLogData> = {}) {
  return logError({ level: 'INFO', component: 'USER', message, ...details });
}

export async function logJobError(message: string, details: Partial<ErrorLogData> = {}) {
  return logError({ level: 'ERROR', component: 'JOB', message, ...details });
}

export async function logWarning(message: string, details: Partial<ErrorLogData> = {}) {
  return logError({ level: 'WARNING', component: 'SYSTEM', message, ...details });
}

export async function logDebug(message: string, details: Partial<ErrorLogData> = {}) {
  return logError({ level: 'DEBUG', component: 'SYSTEM', message, ...details });
}

/**
 * Lambda wrapper helper - auto-logs errors and success
 * Usage: export const handler = withErrorLogging(yourHandler, 'API');
 */
export function withErrorLogging<T = any>(
  handler: (event: any, context: any) => Promise<T>,
  component: ComponentType = 'API'
) {
  return async (event: any, context: any): Promise<T> => {
    const startTime = Date.now();
    const eventInfo = extractLambdaEventInfo(event, context);

    try {
      const result = await handler(event, context);
      
      // Log successful execution for important operations
      if (component === 'API' || component === 'JOB') {
        await logError({
          level: 'INFO',
          component,
          message: `${context.functionName} executed successfully`,
          ...eventInfo,
          requestData: {
            ...eventInfo.requestData,
            executionTime: Date.now() - startTime
          }
        });
      }

      return result;
    } catch (error: any) {
      // Log the error with full context
      await logError({
        level: 'ERROR',
        component,
        message: error.message || 'Unknown error occurred',
        errorCode: error.code || error.name || 'UNHANDLED_ERROR',
        stackTrace: error.stack,
        ...eventInfo,
        requestData: {
          ...eventInfo.requestData,
          functionName: context.functionName,
          executionTime: Date.now() - startTime
        }
      });

      throw error; // Re-throw to maintain original behavior
    }
  };
}

/**
 * Query recent error logs for monitoring/debugging
 */
export async function getRecentErrors(
  level?: LogLevel,
  component?: ComponentType,
  limit = 50,
  hoursBack = 24
): Promise<{ success: boolean; data?: any[]; error?: any }> {
  try {
    let whereClause = `WHERE created_at >= NOW() - INTERVAL '${hoursBack} hours'`;
    const params: any[] = [];
    let paramIndex = 1;

    if (level) {
      whereClause += ` AND level = $${paramIndex}`;
      params.push(level);
      paramIndex++;
    }

    if (component) {
      whereClause += ` AND component = $${paramIndex}`;
      params.push(component);
      paramIndex++;
    }

    const queryText = `
      SELECT id, level, component, message, error_code, user_id, ip_address, 
             endpoint, created_at
      FROM error_logs 
      ${whereClause}
      ORDER BY created_at DESC 
      LIMIT ${limit}
    `;

    return await executeQuery(queryText, params);
  } catch (err: any) {
    return { success: false, error: err.message || err };
  }
}

// ==========================================
// END ERROR LOGGING FUNCTIONALITY
// ==========================================
