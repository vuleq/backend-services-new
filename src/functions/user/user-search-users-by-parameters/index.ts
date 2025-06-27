import { executeQuery } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse, ResponsePage } from '/opt/nodejs/api-model';

type SortColumn = 'name' | 'email' | 'phone' | 'created_at';
type SortOrder = 'ASC' | 'DESC';

interface QueryParams {
  phone?: string;
  name?: string;
  email?: string;
  orderBy: SortColumn;
  sortBy: SortOrder;
  limit: number;
  offset: number;
}

export const handler = async (event: any) => {
  console.log('Receive Event:', event);
  
  try {
    const queryParams = parseQueryParameters(event.queryStringParameters || {});
    const { query, params } = buildQuery(queryParams);
    
    console.log('Query:', query);
    console.log('Params:', params);
    
    const result = await executeQuery(query, params);
    
    if (!result.success) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Error executing query', result.error));
    }

    const total = result.data.length > 0 ? parseInt(result.data[0].total_count, 10) : 0;
    const users = result.data.map((row: { total_count: number; [key: string]: any }) => {
      const { total_count, ...user } = row;
      return user;
    });

    return new LambdaResponse(200, new ResponsePage(queryParams.offset, queryParams.limit, total, users));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};

function parseQueryParameters(params: Record<string, any>): QueryParams {
  const validSortColumns: SortColumn[] = ['name', 'email', 'phone', 'created_at'];
  const limit = Math.min(Math.max(parseInt(params.limit, 10) || 10, 1), 100);
  const offset = Math.max(parseInt(params.offset, 10) || 0, 0);
  
  return {
    phone: params.phone?.trim() || undefined,
    name: params.name?.trim() || undefined,
    email: params.email?.trim() || undefined,
    orderBy: validSortColumns.includes(params.orderBy as SortColumn) ? params.orderBy : 'created_at',
    sortBy: params.sortBy?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC',
    limit,
    offset
  };
}

function buildQuery(params: QueryParams): { query: string, params: any[] } {
  const conditions: string[] = [];
  const queryParams: any[] = [];
  let paramIndex = 1;

  if (params.phone) {
    conditions.push(`phone ILIKE ${paramIndex++}`);
    queryParams.push(`%${params.phone}%`);
  }

  if (params.name) {
    conditions.push(`name ILIKE ${paramIndex++}`);
    queryParams.push(`%${params.name}%`);
  }

  if (params.email) {
    conditions.push(`email ILIKE ${paramIndex++}`);
    queryParams.push(`%${params.email}%`);
  }

  const whereClause = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
  
  const query = `
    SELECT *, COUNT(*) OVER() as total_count 
    FROM users${whereClause}
    ORDER BY ${params.orderBy} ${params.sortBy}
    LIMIT ${paramIndex++} OFFSET ${paramIndex++}
  `;
  queryParams.push(params.limit, params.offset);
  
  return { query, params: queryParams };
}
