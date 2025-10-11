/**
 * Database Connection Management
 * No pooling - provides fresh connection utilities and cache clearing
 */

import { Client } from 'pg';
import { getDbConfig } from './database-config.js';
import { clearIAMTokenCache } from './iam-auth.js';
import { clearSecretsClientCache } from './secrets-manager.js';

/**
 * Get a fresh database client connection
 * Creates a new client every time - no pooling
 */
export async function getFreshConnection(): Promise<Client> {
  console.log('Creating fresh database client connection (no pooling)...');
  
  const dbConfig = await getDbConfig();
  const client = new Client(dbConfig);
  
  try {
    await client.connect();
    console.log('Fresh database client connected successfully');
    return client;
  } catch (error) {
    console.error('Error connecting fresh database client:', error);
    
    // Clean up the client if connection failed
    try {
      await client.end();
    } catch (endError) {
      console.error('Error ending failed client connection:', endError);
    }
    
    throw error;
  }
}

/**
 * Clear all credential and token caches
 * Forces fresh retrieval on next connection
 */
export function clearAllCaches(): void {
  console.log('Clearing all caches (credentials, IAM tokens, etc.)...');
  clearIAMTokenCache();
  clearSecretsClientCache();
}

/**
 * Test database connectivity with fresh connection
 */
export async function testConnection(): Promise<boolean> {
  let client: Client | null = null;
  
  try {
    console.log('Testing database connectivity with fresh connection...');
    client = await getFreshConnection();
    
    // Simple connectivity test
    const result = await client.query('SELECT 1 as test');
    console.log('Database connectivity test successful:', result.rows[0]);
    
    return true;
  } catch (error) {
    console.error('Database connectivity test failed:', error);
    return false;
  } finally {
    if (client) {
      try {
        await client.end();
        console.log('Test connection closed');
      } catch (endError) {
        console.error('Error closing test connection:', endError);
      }
    }
  }
}

// Legacy function names for compatibility (no-ops since we don't use pooling)
export const initializePool = async (): Promise<void> => {
  console.log('Pool initialization skipped - using fresh connections');
};

export const getPoolStatus = () => ({
  isInitialized: false,
  totalCount: 0,
  idleCount: 0,
  waitingCount: 0
});

export const closePool = async (): Promise<void> => {
  console.log('Pool closing skipped - no pool to close');
};

export const getPool = (): never => {
  throw new Error('Pool not available - using fresh connections only');
};

export const ensureConnection = async (): Promise<boolean> => {
  try {
    return await testConnection();
  } catch {
    return false;
  }
};