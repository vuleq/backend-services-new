import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { ERROR_CODES } from 'wdr-error-codes';

// Define interfaces for request/response
interface GetLogFilters {
  timeRange?: {
    from: string; // ISO format: 2024-08-11T00:00:00Z
    to: string;   // ISO format: 2024-08-11T23:59:59Z
  };
  component?: 'JOB' | 'USER' | 'API' | 'DATABASE' | 'SYSTEM';
  severity?: 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG' | 'CRITICAL';
  search?: string; // Search in message content
  page?: number;
  limit?: number;
}

interface LogEntry {
  id: string;
  level: string;
  component: string;
  message: string;
  error_code?: string;
  user_id?: string;
  ip_address?: string;
  endpoint?: string;
  request_data?: any;
  stack_trace?: string;
  created_at: string;
  created_by?: string;
}

interface GetLogResponse {
  logs: LogEntry[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  filters: GetLogFilters;
  counts: {
    criticalErrors: number;
    errors: number;
    warnings: number;
    totalEvents: number;
  };
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    console.log('Received event:', JSON.stringify(event, null, 2));

    // Log DB config for debugging (remove in production)
    console.log('DB Config:', {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD ? '***' : 'MISSING'
    });

    // Parse filters - handle both API Gateway and direct invocation
    const filters: GetLogFilters = parseFilters(event);

    console.log('Applied filters:', filters);

    // Validate inputs
    validateFilters(filters);

    // Build the SQL query with filters
    const { query, countQuery, countsQuery, params } = buildLogQuery(filters);
    
    console.log('Generated query:', query);
    console.log('Query params:', params);

    // Execute count query for pagination
    const countResult = await executeQuery(countQuery, params);
    if (!countResult.success) {
      console.error('Count query failed:', countResult.error);
      throw new Error('Failed to count logs');
    }

    // Execute counts query for severity counts
    const countsResult = await executeQuery(countsQuery, params);
    if (!countsResult.success) {
      console.error('Counts query failed:', countsResult.error);
      throw new Error('Failed to get severity counts');
    }

    const total = parseInt(countResult.data[0]?.count || '0');
    const totalPages = Math.ceil(total / filters.limit!);

    // Process severity counts
    const counts = {
      criticalErrors: 0,
      errors: 0,
      warnings: 0,
      totalEvents: 0
    };

    countsResult.data.forEach((row: any) => {
      const level = row.level?.toUpperCase();
      const count = parseInt(row.count || '0');
      
      switch (level) {
        case 'CRITICAL':
          counts.criticalErrors = count;
          break;
        case 'ERROR':
          counts.errors = count;
          break;
        case 'WARNING':
          counts.warnings = count;
          break;
      }
      counts.totalEvents += count;
    });

    // Execute main query with pagination
    const offset = (filters.page! - 1) * filters.limit!;
    const paginatedQuery = `${query} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const paginatedParams = [...params, filters.limit, offset];

    const logsResult = await executeQuery(paginatedQuery, paginatedParams);
    if (!logsResult.success) {
      console.error('Logs query failed:', logsResult.error);
      throw new Error('Failed to fetch logs');
    }

    // Format response
    const response: GetLogResponse = {
      logs: logsResult.data,
      pagination: {
        page: filters.page!,
        limit: filters.limit!,
        total,
        totalPages
      },
      filters: filters,
      counts: counts
    };

    console.log(`Successfully retrieved ${logsResult.data.length} logs (${total} total)`);

    // Return proper API Gateway proxy response
    return LambdaResponse.success(new ApiResponse(true, response, `Retrieved ${logsResult.data.length} log entries`));

  } catch (error: any) {
    console.error('Error in wdr-get-all-log:', error);
    
    if (error.name === 'ValidationError') {
      return LambdaResponse.error(new ApiResponse(false, null, error.message, ERROR_CODES.INVALID_REQUEST.code));
    } else {
      return LambdaResponse.error(new ApiResponse(false, null, 'Internal server error', ERROR_CODES.INTERNAL_SERVER_ERROR?.code || 500));
    }
  }
};

/**
 * Parse filters from different event types (API Gateway vs direct invocation)
 */
function parseFilters(event: any): GetLogFilters {
  // For API Gateway events
  const queryParams = event.queryStringParameters || {};
  let body = {};
  
  // Parse body if it exists
  if (event.body) {
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (err) {
      console.warn('Failed to parse event.body:', err);
      body = {};
    }
  }
  
  // For direct invocation (event is the data itself)
  const directData = (!event.queryStringParameters && !event.body) ? event : {};
  
  // Merge all sources
  const sourceData = { ...queryParams, ...body, ...directData };

  return {
    timeRange: parseTimeRange(sourceData),
    component: sourceData.component || null,
    severity: sourceData.severity || null,
    search: sourceData.search || null,
    page: parseInt(sourceData.page || '1'),
    limit: Math.min(parseInt(sourceData.limit || '50'), 1000)
  };
}

/**
 * Parse time range from data source
 */
function parseTimeRange(data: any): { from: string; to: string } | undefined {
  // Try timeRange object first
  if (data.timeRange && typeof data.timeRange === 'object') {
    const { from, to } = data.timeRange;
    if (from && to && from !== null && to !== null) {
      return { from, to };
    }
  }
  
  // Try individual fields
  const from = data.timeFrom || data.from;
  const to = data.timeTo || data.to;
  
  if (from && to && from !== null && to !== null) {
    return { from, to };
  }

  return undefined;
}

/**
 * Validate filter parameters
 */
function validateFilters(filters: GetLogFilters): void {
  const errors: string[] = [];

  // Validate time range
  if (filters.timeRange) {
    if (!isValidDate(filters.timeRange.from)) {
      errors.push('Invalid timeRange.from format. Use ISO format: 2024-08-11T00:00:00Z');
    }
    if (!isValidDate(filters.timeRange.to)) {
      errors.push('Invalid timeRange.to format. Use ISO format: 2024-08-11T23:59:59Z');
    }
    if (filters.timeRange.from && filters.timeRange.to) {
      const fromDate = new Date(filters.timeRange.from);
      const toDate = new Date(filters.timeRange.to);
      if (fromDate >= toDate) {
        errors.push('timeRange.from must be earlier than timeRange.to');
      }
    }
  }

  // Validate component
  if (filters.component) {
    const validComponents = ['JOB', 'USER', 'API', 'DATABASE', 'SYSTEM'];
    if (!validComponents.includes(filters.component)) {
      errors.push(`Invalid component. Valid values: ${validComponents.join(', ')}`);
    }
  }

  // Validate severity
  if (filters.severity) {
    const validSeverities = ['ERROR', 'WARNING', 'INFO', 'DEBUG', 'CRITICAL'];
    if (!validSeverities.includes(filters.severity)) {
      errors.push(`Invalid severity. Valid values: ${validSeverities.join(', ')}`);
    }
  }

  // Validate pagination
  if (filters.page && (filters.page < 1 || filters.page > 10000)) {
    errors.push('Page must be between 1 and 10000');
  }
  if (filters.limit && (filters.limit < 1 || filters.limit > 1000)) {
    errors.push('Limit must be between 1 and 1000');
  }

  if (errors.length > 0) {
    throw new ValidationError(errors.join(', '));
  }
}

/**
 * Build SQL query with dynamic filters - FIXED VERSION
 */
function buildLogQuery(filters: GetLogFilters): { query: string; countQuery: string; countsQuery: string; params: any[] } {
  const baseQuery = `
    SELECT 
      id,
      level,
      component,
      message,
      error_code,
      user_id,
      ip_address,
      endpoint,
      request_data,
      stack_trace,
      created_at,
      created_by
    FROM error_logs
  `;

  const countBaseQuery = 'SELECT COUNT(*) as count FROM error_logs';
  const countsBaseQuery = 'SELECT level, COUNT(*) as count FROM error_logs';
  
  const whereClauses: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  // Time Range filter
  if (filters.timeRange) {
    if (filters.timeRange.from != null) {
      whereClauses.push(`created_at >= $${paramIndex++}`);
      params.push(filters.timeRange.from);
    }

    if (filters.timeRange.to != null) {
      whereClauses.push(`created_at <= $${paramIndex++}`);
      params.push(filters.timeRange.to);
    }
  }

  // Component filter
  if (filters.component) {
    whereClauses.push(`component = $${paramIndex++}`);
    params.push(filters.component);
  }

  // Severity filter
  if (filters.severity) {
    whereClauses.push(`level = $${paramIndex++}`);
    params.push(filters.severity);
  }

  // Search filter (case-insensitive partial matching in message)
  if (filters.search) {
    whereClauses.push(`message ILIKE $${paramIndex++}`);
    params.push(`%${filters.search}%`);
  }

  // Build WHERE clause
  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // Default order by created_at DESC
  const orderBy = 'ORDER BY created_at DESC';

  // Complete queries
  const query = `${baseQuery} ${whereClause} ${orderBy}`;
  const countQuery = `${countBaseQuery} ${whereClause}`;
  const countsQuery = `${countsBaseQuery} ${whereClause} GROUP BY level`;

  return { query, countQuery, countsQuery, params };
}

/**
 * Validate date format
 */
function isValidDate(dateString: string): boolean {
  const date = new Date(dateString);
  return !isNaN(date.getTime()) && dateString.includes('T');
}