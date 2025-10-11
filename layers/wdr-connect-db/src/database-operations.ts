/**
 * Database CRUD Operations Module
 * Handles basic database operations (create, read, update, delete)
 * Each operation creates a fresh connection (no pooling)
 */

import { Client } from 'pg';
import { getDbConfig } from './database-config.js';
import { DatabaseResult } from './types.js';

/**
 * Validate table name to prevent SQL injection
 */
function validateTableName(tableName: string): string {
  if (!tableName || typeof tableName !== 'string' || /[^a-zA-Z0-9_]/.test(tableName)) {
    throw new Error('Invalid table name');
  }
  return tableName;
}

/**
 * Test database connectivity with a fresh connection
 */
export async function testConnection(): Promise<DatabaseResult> {
  return await executeQuery('SELECT 1 as test', []);
}

/**
 * Execute a raw SQL query with parameters
 * Creates a fresh connection for each query (no pooling)
 */
export async function executeQuery(queryText: string, params: any[] = []): Promise<DatabaseResult> {
  let client: Client | null = null;
  const queryTimeout = parseInt(process.env.DB_STATEMENT_TIMEOUT || '5000'); // 5 seconds default
  const connectionTimeout = parseInt(process.env.DB_CONNECTION_TIMEOUT || '10000'); // 10 seconds for connection
  
  try {
    // Get fresh database configuration (may include fresh credentials)
    const dbConfig = await getDbConfig();
    
    // Create a completely new client for this query
    client = new Client(dbConfig);
    
    // Connect with timeout protection
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error(`Connection timeout after ${connectionTimeout}ms`)), connectionTimeout)
      )
    ]);
    
    console.log('Fresh database connection established for query');
    
    // Execute query with timeout protection
    const queryConfig = {
      text: queryText,
      values: params,
      statement_timeout: queryTimeout
    };
    
    const result = await Promise.race([
      client.query(queryConfig),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error(`Query execution timeout after ${queryTimeout}ms`)), queryTimeout + 1000)
      )
    ]);
    
    console.log(`Query executed successfully on fresh connection: ${queryText.substring(0, 50)}...`);
    
    return { 
      success: true, 
      data: result.rows, 
      rowCount: result.rowCount === null ? undefined : result.rowCount 
    };
  } catch (err: any) {
    console.error('Error executing query with fresh connection:', {
      error: err.message || err,
      query: queryText.substring(0, 100) + (queryText.length > 100 ? '...' : ''),
      params: params?.length || 0,
      timeout: queryTimeout
    });
    return { success: false, error: err.message || err };
  } finally {
    // Always close the connection after use
    if (client) {
      try {
        await client.end();
        console.log('Fresh connection closed');
      } catch (closeErr) {
        console.error('Error closing fresh connection:', closeErr);
      }
    }
  }
}

/**
 * Insert a record into a table
 */
export async function insertRecord(
  tableName: string, 
  data: Record<string, any>, 
  returningClause = '*'
): Promise<DatabaseResult> {
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

/**
 * Update records in a table
 */
export async function updateRecord(
  tableName: string, 
  data: Record<string, any>, 
  condition: Record<string, any>, 
  returningClause = '*'
): Promise<DatabaseResult> {
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

/**
 * Delete records from a table
 */
export async function deleteRecord(
  tableName: string, 
  condition: Record<string, any>, 
  returningClause = ''
): Promise<DatabaseResult> {
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