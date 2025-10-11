import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse, ResponsePage } from 'wdr-models';
import { ERROR_CODES, buildError } from 'wdr-error-codes';

// Add types for query params and response
interface DynamicValue {
  id: string;
  name: string;
  description: string;
}

interface QueryParams {
  'search-text'?: string;
  'sort-by'?: string;
  'page-number'?: string;
  'order-by'?: string;
  'page-size'?: string;
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Receive Event:', event);

  try {
    const queryParams: QueryParams = event.queryStringParameters || {};

    const searchString = queryParams['search-text'];
    const sortBy = queryParams['sort-by'] ?? '';
    const offset = queryParams['page-number'] ?? '0';
    const orderBy = queryParams['order-by'] ?? 'DESC';
    const limit = queryParams['page-size'] ?? '10';

    // Build WHERE clause based on provided filters
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (searchString) {
      const searchPattern = `%${searchString}%`;
      conditions.push(`(name ILIKE $${paramIndex++} OR description ILIKE $${paramIndex++})`);
      params.push(searchPattern, searchPattern);
    }

    // Build the query with count
    let query = `SELECT name, description, COUNT(*) OVER() as total_count FROM dynamic_values`;

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    // Add sorting
    const validSortColumns = ['name', 'description'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'updated_at';
    const sortOrder = orderBy.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    query += ` ORDER BY ${sortColumn} ${sortOrder}`;

    // Add pagination
    const limitNum = parseInt(limit, 10) || 10;
    const offsetNum = parseInt(offset, 10) || 0;

    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(limitNum, offsetNum);

    console.log('Query: ', query);
    console.log('Params: ', params);

    // Execute query
    const result = await executeQuery(query, params);
    console.log('Result: ', result);

    if (!result.success) {
      const err = buildError('DATABASE_ERROR', result.error ?? 'Failed to check existing Dynamic value');
      return new LambdaResponse(500, err);
    }

    // Map result data to response format and get total count from first row
    const total = result.data.length > 0 ? parseInt(result.data[0].total_count ?? '0', 10) : 0;

    const responseData = result.data.map((dynamicValue: DynamicValue) => ({
      id: dynamicValue.id,
      name: dynamicValue.name,
      description: dynamicValue.description,
    }));

    return new LambdaResponse(200, new ResponsePage(offsetNum, limitNum, total, responseData));
  } catch (error: any) {
    console.error('Error:', error);
    const err = buildError('DATABASE_ERROR', error.message);
    return new LambdaResponse(500, err);
  }
};