import { executeQuery } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse, ResponsePage } from '/opt/nodejs/api-model';

type SortOrder = 'ASC' | 'DESC';
type SortColumn = 'name' | 'created_by' | 'create_at';

interface QueryParams {
  name?: string;
  createdBy?: string;
  sortBy: SortColumn;
  orderBy: SortOrder;
  limit: number;
  offset: number;
}

export const handler = async (event: any) => {
  console.log('Receive Event:', event);
  
  try {
    // Parse and validate query parameters
    let queryParams: QueryParams;
    try {
      queryParams = parseQueryParameters(event.queryStringParameters || {});
    } catch (error: any) {
      return new LambdaResponse(400, new ApiResponse(false, null, error.message));
    }

    // Validate createdBy parameter format
    if (queryParams.createdBy && !queryParams.createdBy.match(/^[a-zA-Z0-9_]+$/)) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid createdBy format'));
    }

    const { query, params, conditions } = buildQuery(queryParams);

    console.log('Query: ', query);
    console.log('Params: ', params);

    // Execute query
    const result = await executeQuery(query, params);

    console.log('Result: ', result);

    if (!result.success) {
      return new ApiResponse(false, null, 'Error executing query', result.error);
    }

    // Get total count for pagination
    const countQuery = 'SELECT COUNT(*) as total FROM trade_sections' + 
      (conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '');

    // Use the same parameters as the main query but exclude pagination parameters
    const countParams = params.slice(0, params.length - 2);
    const countResult = await executeQuery(countQuery, countParams);

    if (!countResult.success) {
      return new LambdaResponse(500, new ApiResponse(false, null, 'Error executing count query', result.error));
    }

    const total = parseInt(countResult.data[0].total, 10);

    return new LambdaResponse(200, new ResponsePage(queryParams.offset, queryParams.limit, total, result.data));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};

function parseQueryParameters(params: Record<string, any>): QueryParams {
  const validSortColumns: SortColumn[] = ['name', 'created_by', 'create_at'];
  const sortBy = params['sort-by'];
  
  // Parse and validate limit/offset
  const limit = parseInt(params.limit, 10) || 10;
  const offset = parseInt(params.offset, 10) || 0;
  
  if (limit <= 0 || limit > 100) {
    throw new Error("Invalid 'limit' parameter. Must be between 1 and 100.");
  }
  
  if (offset < 0) {
    throw new Error("Invalid 'offset' parameter. Must be greater than or equal to 0.");
  }
  
  return {
    name: params.name ? params.name.trim() : undefined,
    createdBy: params['created-by'] ? params['created-by'].trim() : undefined,
    sortBy: validSortColumns.includes(sortBy as SortColumn) ? sortBy as SortColumn : 'create_at',
    orderBy: params['order-by']?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC',
    limit,
    offset
  };
}

function buildQuery(params: QueryParams): { query: string, params: any[], conditions: string[] } {
  const conditions: string[] = [];
  const queryParams: any[] = [];
  let paramIndex = 1;

  if (params.name) {
    conditions.push(`name ILIKE ${paramIndex++}`);
    queryParams.push(`%${params.name}%`);
  }

  if (params.createdBy) {
    conditions.push(`created_by = ${paramIndex++}`);
    queryParams.push(params.createdBy);
  }
  
  // Always include is_deleted condition, defaulting to false if not specified
  conditions.push(`is_deleted = ${paramIndex++}`);
  queryParams.push(false);
  
  // Build the query
  let query = 'SELECT * FROM trade_sections';
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  
  // Add sorting
  query += ` ORDER BY ${params.sortBy} ${params.orderBy}`;
  
  // Add pagination
  query += ` LIMIT ${paramIndex++} OFFSET ${paramIndex++}`;
  queryParams.push(params.limit, params.offset);
  
  return { query, params: queryParams, conditions };
}
