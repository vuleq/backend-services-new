/**
 * AWS Secrets Manager Client Management
 * No caching - creates fresh client and fetches fresh credentials every time
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Agent as HttpsAgent } from 'https';
import { DatabaseCredentials } from './types.js';

// Configuration for fresh requests every time
const SECRET_NAME = process.env.DB_SECRET_ARN || "rds-db-credentials/cluster-SUDETH5ZXZOFLLIXDRLOHWXVRQ/postgre/1754619987257";
const SECRETS_TIMEOUT = parseInt(process.env.DB_SECRETS_TIMEOUT || '60000'); // 60 seconds timeout
const MAX_RETRIES = parseInt(process.env.DB_SECRETS_MAX_RETRIES || '5'); // 5 retries

// Debug logging for timeout configuration
console.log(`Secrets Manager Configuration (NO CACHE): timeout=${SECRETS_TIMEOUT}ms, retries=${MAX_RETRIES}, region=${process.env.AWS_REGION || "ap-southeast-1"}`);

/**
 * Create a fresh SecretsManagerClient instance
 * Creates a new client every time - no reuse
 */
function createFreshSecretsClient(): SecretsManagerClient {
  console.log('Creating fresh SecretsManagerClient instance (no cache)...');
  
  // Create custom HTTP agent with keepAlive = false
  const httpsAgent = new HttpsAgent({
    keepAlive: false, // Disable keep alive for completely fresh connections
    maxSockets: 10,
    timeout: SECRETS_TIMEOUT
  });
  
  // Create custom request handler with the HTTP agent
  const requestHandler = new NodeHttpHandler({
    httpsAgent,
    requestTimeout: SECRETS_TIMEOUT,
    connectionTimeout: Math.min(SECRETS_TIMEOUT / 2, 30000)
  });
  
  return new SecretsManagerClient({
    region: process.env.AWS_REGION || "ap-southeast-1",
    requestHandler,
    maxAttempts: MAX_RETRIES,
    retryMode: "adaptive",
    logger: {
      debug: (msg) => console.log('AWS SDK Debug:', msg),
      info: (msg) => console.log('AWS SDK Info:', msg),
      warn: (msg) => console.warn('AWS SDK Warning:', msg),
      error: (msg) => console.error('AWS SDK Error:', msg)
    }
  });
}

/**
 * Get a fresh SecretsManagerClient
 * Always creates a new client - no caching
 */
function getSecretsClient(): SecretsManagerClient {
  return createFreshSecretsClient();
}

/**
 * Clear any client-related resources (no-op since we don't cache)
 */
export function clearSecretsClientCache(): void {
  console.log('No cache to clear - using fresh clients every time');
}

/**
 * Retrieve database credentials from AWS Secrets Manager
 * Always fetches fresh credentials - no caching
 */
export async function getDatabaseCredentials(): Promise<DatabaseCredentials> {
  console.log('Fetching fresh database credentials from Secrets Manager (no cache)...');
  
  const client = getSecretsClient();
  const command = new GetSecretValueCommand({
    SecretId: SECRET_NAME,
  });

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Secrets Manager request timed out after ${SECRETS_TIMEOUT}ms`));
      }, SECRETS_TIMEOUT);
    });

    // Race between the actual request and timeout
    const response = await Promise.race([
      client.send(command),
      timeoutPromise
    ]);

    if (!response.SecretString) {
      throw new Error('Secret string is empty or undefined');
    }

    const credentials = JSON.parse(response.SecretString) as DatabaseCredentials;
    
    // Validate required fields
    if (!credentials.username || !credentials.password || !credentials.host || !credentials.port) {
      throw new Error('Invalid credentials: missing required fields (username, password, host, port)');
    }

    console.log('Fresh database credentials retrieved successfully');
    return credentials;

  } catch (error) {
    console.error('Error retrieving fresh database credentials:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('timed out')) {
        console.error(`Secrets Manager timeout after ${SECRETS_TIMEOUT}ms - consider increasing DB_SECRETS_TIMEOUT environment variable`);
      }
      
      // Re-throw with enhanced error information
      throw new Error(`Failed to retrieve database credentials: ${error.message}`);
    }
    
    throw new Error('Failed to retrieve database credentials: Unknown error');
  }
}

/**
 * Check if credentials are valid (basic validation)
 * Since we don't cache, this is just a simple validation function
 */
export function validateCredentials(credentials: DatabaseCredentials | null): boolean {
  if (!credentials) {
    console.log('No credentials provided for validation');
    return false;
  }
  
  const isValid = !!(
    credentials.username &&
    credentials.password &&
    credentials.host &&
    credentials.port
  );
  
  console.log(`Credentials validation result: ${isValid ? 'valid' : 'invalid'}`);
  return isValid;
}

// Legacy function names for compatibility
export const getSecretsManagerCredentials = getDatabaseCredentials;
export const refreshSecretsManagerClient = clearSecretsClientCache;
export const refreshCredentials = async (): Promise<boolean> => {
  try {
    await getDatabaseCredentials();
    return true;
  } catch {
    return false;
  }
};
export const clearCredentialsCache = clearSecretsClientCache;
export const getCredentialsCacheStatus = () => ({ isCached: false });