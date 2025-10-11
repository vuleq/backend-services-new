/**
 * Database Transaction Module
 * Handles complex transactions with dynamic value resolution between operations
 * Uses fresh connections for each transaction (no pooling)
 */

import { Client } from 'pg';
import { getDbConfig } from './database-config.js';
import { 
  Operation, 
  TransactionResult, 
  DynamicValue, 
  OperationValue 
} from './types.js';

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
 * Helper function to resolve dynamic values from previous operation results
 */
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

/**
 * Executes multiple database operations in a single transaction with dynamic value resolution.
 * Creates a fresh connection for each transaction (no pooling)
 * 
 * Dynamic values: Reference previous operation results using:
 *   { type: 'dynamic_result', fromIndex: 0, field: 'id' }
 */
export async function performTransaction(operations: Operation[]): Promise<TransactionResult> {
  let client: Client | null = null;
  // `allOperationResults` will store the full `result.rows` for each operation
  // This allows `resolveDynamicValue` to look up any previous result.
  const allOperationResults: any[][] = [];

  try {
    // Get fresh database configuration
    const dbConfig = await getDbConfig();
    
    // Create a completely fresh client for this transaction
    client = new Client(dbConfig);
    await client.connect();
    
    console.log('Fresh database connection established for transaction');
    
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
    console.log('Transaction committed successfully on fresh connection');
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
      try {
        await client.end();
        console.log('Fresh transaction connection closed');
      } catch (closeErr) {
        console.error('Error closing fresh transaction connection:', closeErr);
      }
    }
  }
}