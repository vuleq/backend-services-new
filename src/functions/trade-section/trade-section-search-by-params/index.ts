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
    const queryParams = parseQueryParameters(event.queryStringParameters || {});

    const { query, params } = buildQuery(queryParams);

    console.log('Query: ', query);
    console.log('Params: ', params);

    const result = await executeQuery(query, params);

    if (!result.success) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Error executing query', result.error));
    }

    const total = result.data.length > 0 ? parseInt(result.data[0].total_count, 10) : 0;
    const tradeSections = result.data.map((row: { total_count: number; [key: string]: any }) => {
      const { total_count, ...section } = row;
      return section;
    });

    return new LambdaResponse(200, new ResponsePage(queryParams.offset, queryParams.limit, total, tradeSections));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};

function parseQueryParameters(params: Record<string, any>): QueryParams {
  const validSortColumns: SortColumn[] = ['name', 'created_by', 'create_at'];
  const limit = Math.min(Math.max(parseInt(params.limit, 10) || 10, 1), 100);
  const offset = Math.max(parseInt(params.offset, 10) || 0, 0);
  
  return {
    name: params.name?.trim() || undefined,
    createdBy: params['created-by']?.trim() || undefined,
    sortBy: validSortColumns.includes(params['sort-by'] as SortColumn) ? params['sort-by'] : 'create_at',
    orderBy: params['order-by']?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC',
    limit,
    offset
  };
}

function buildQuery(params: QueryParams): { query: string, params: any[] } {
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
  
  conditions.push(`is_deleted = ${paramIndex++}`);
  queryParams.push(false);
  
  const whereClause = ' WHERE ' + conditions.join(' AND ');
  
  const query = `
    SELECT *, COUNT(*) OVER() as total_count 
    FROM trade_sections${whereClause}
    ORDER BY ${params.sortBy} ${params.orderBy}
    LIMIT ${paramIndex++} OFFSET ${paramIndex++}
  `;
  queryParams.push(params.limit, params.offset);
  
  return { query, params: queryParams };
}
