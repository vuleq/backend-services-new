/**
 * Error Logging Module
 * Comprehensive error logging system with Lambda wrapper utilities
 */

import { 
  LogLevel, 
  ComponentType, 
  ErrorLogData, 
  LambdaEventInfo, 
  DatabaseResult 
} from './types.js';
import { insertRecord, executeQuery } from './database-operations.js';

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
): Promise<DatabaseResult> {
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