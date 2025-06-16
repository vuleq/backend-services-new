import { Pool, PoolConfig } from 'pg';

let isPoolInitialized = false;

const dbConfig: PoolConfig = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
};

let pool = new Pool(dbConfig);

pool.on('error', (err: Error) => {
  console.error('Unexpected error on idle client', err);
  isPoolInitialized = false;
});

export async function ensureConnection(): Promise<boolean> {
  if (!isPoolInitialized) {
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      isPoolInitialized = true;
      console.log('Database connection established successfully');
    } catch (err) {
      console.error('Failed to establish database connection:', err);
      pool = new Pool(dbConfig);
      throw err;
    }
  }
  return isPoolInitialized;
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

export async function performTransaction(operations: Array<any>) {
  let client;
  const results: any[] = [];
  try {
    await ensureConnection();
    client = await pool.connect();
    await client.query('BEGIN');
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      let queryText;
      let values;
      let result;
      if (op.table) {
        op.table = validateTableName(op.table);
      }
      if (op.type === 'insert') {
        const columns = Object.keys(op.data);
        values = Object.values(op.data);
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
        const returningClause = op.returningClause || '';
        queryText = `INSERT INTO ${op.table} (${columns.join(', ')}) VALUES (${placeholders})${returningClause ? ` RETURNING ${returningClause}` : ''};`;
        const queryConfig = {
          text: queryText,
          values: values,
          statement_timeout: 25000
        };
        result = await client.query(queryConfig);
        if (result.rows && result.rows.length > 0) {
          results[i] = result.rows;
          op.result = result.rows[0];
        }
      } else if (op.type === 'update') {
        const setClauses = Object.keys(op.data).map((key, index) => `${key} = $${index + 1}`).join(', ');
        const setValues = Object.values(op.data);
        const conditionClauses = Object.keys(op.condition).map((key, index) => `${key} = $${setValues.length + index + 1}`).join(' AND ');
        const conditionValues = Object.values(op.condition);
        values = [...setValues, ...conditionValues];
        const returningClause = op.returningClause || '';
        queryText = `UPDATE ${op.table} SET ${setClauses} WHERE ${conditionClauses}${returningClause ? ` RETURNING ${returningClause}` : ''};`;
        const queryConfig = {
          text: queryText,
          values: values,
          statement_timeout: 25000
        };
        result = await client.query(queryConfig);
        if (result.rows && result.rows.length > 0) {
          results[i] = result.rows;
          op.result = result.rows;
        }
      } else if (op.type === 'delete') {
        const conditionClauses = Object.keys(op.condition).map((key, index) => `${key} = $${index + 1}`).join(' AND ');
        values = Object.values(op.condition);
        const returningClause = op.returningClause || '';
        queryText = `DELETE FROM ${op.table} WHERE ${conditionClauses}${returningClause ? ` RETURNING ${returningClause}` : ''};`;
        const queryConfig = {
          text: queryText,
          values: values,
          statement_timeout: 25000
        };
        result = await client.query(queryConfig);
        if (result.rows && result.rows.length > 0) {
          results[i] = result.rows;
          op.result = result.rows;
        }
      } else if (op.type === 'query') {
        const queryConfig = {
          text: op.queryText,
          values: op.params || [],
          statement_timeout: 25000
        };
        result = await client.query(queryConfig);
        if (result.rows && result.rows.length > 0) {
          results[i] = result.rows;
          op.result = result.rows;
        }
      } else {
        throw new Error(`Unsupported operation type: ${op.type}`);
      }
    }
    await client.query('COMMIT');
    return { success: true, results, message: 'Transaction completed successfully.' };
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
