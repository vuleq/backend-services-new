import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { buildError } from 'wdr-error-codes';

const validSortColumns: Record<string, string> = {
  'name': 's.name'
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Receive Event:', event);

  const {
    name,
    limit,
    offset,
    'sort-by': sortBy,
    'order-by': orderBy
  } = event.queryStringParameters || {};

  // Validate limit parameter
  const limitNum = limit ? parseInt(limit, 10) : 10;
  if (isNaN(limitNum) || limitNum < 0) {
    return new LambdaResponse(400, buildError('MISSING_REQUIRED_FIELD', "Invalid 'limit' query parameter. Must be a number >= 0."));
  }

  // Validate offset parameter
  const offsetNum = offset ? parseInt(offset, 10) : 0;
  if (isNaN(offsetNum) || offsetNum < 0) {
    return new LambdaResponse(400, buildError('MISSING_REQUIRED_FIELD', "Invalid 'offset' query parameter. Must be a number >= 0."));
  }

  try {
    // Build WHERE clause based on provided filters
    const conditions = [];
    const params = [];
    const countParams = [];
    let paramIndex = 1;

    if (name) {
      const searchPattern = `%${name}%`;
      conditions.push(`s.name ILIKE $${paramIndex++}`);
      params.push(searchPattern);
      countParams.push(searchPattern);
    }

    // Build the query with count and work_categories
    let query = `
      SELECT 
        s.*,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', wc.id,
              'name', wc.name
            )
          ) FILTER (WHERE wc.id IS NOT NULL), 
          '[]'::json
        ) as work_categories
      FROM trade_sections s 
      LEFT JOIN work_categories wc ON s.id = wc.trade_section_id`;

    let countQuery = `
      SELECT COUNT(*) as total_count
      FROM trade_sections s`;

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
      countQuery += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' GROUP BY s.id';

    // Add sorting
    const sortColumn = sortBy && sortBy in validSortColumns ? validSortColumns[sortBy] : 's.updated_at';
    const sortOrder = orderBy && orderBy.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    query += ` ORDER BY ${sortColumn} ${sortOrder}`;

    // Add pagination
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(limitNum, offsetNum * limitNum);

    console.log('Query: ', query);
    console.log('Params: ', params);

    // Execute query
    const [result, countResult] = await Promise.all([
      executeQuery(query, params),
      executeQuery(countQuery, countParams)
    ]);

    if (!result.success || !countResult.success) {
      return new LambdaResponse(500, new ApiResponse(false, null, 'Error executing query'));
    }

    const total = parseInt(countResult.data[0].total_count);

    return new LambdaResponse(200, new ApiResponse(true, { pageNumber: offsetNum, pageSize: limitNum, totalCount: total, data: result.data }));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(400, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};
