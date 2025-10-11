import { executeQuery, logAPIError, logDatabaseError } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

export const handler = async (event) => {
  console.log('Receive Event:', event);

  try {
    const queryParams = event.queryStringParameters || {};

    const searchString = queryParams['search-text'];
    const sortBy = queryParams['sort-by'];
    const offset = queryParams['page-number'];
    const orderBy = queryParams['order-by'];
    const limit = queryParams['page-size'];
    const projectId = queryParams['project-id'];

    // Build WHERE clause based on provided filters
    const conditions = [];
    const params = [];
    let countParams = [];
    let paramIndex = 1;

    if (projectId) {
      conditions.push(`project_id = $${paramIndex++}`);
      params.push(projectId);
    } else {
      await logAPIError('Project ID is required');
      return new LambdaResponse(400, new ApiResponse(false, null, 'Project ID is required', null));
    }

    if (searchString) {
      const searchPattern = `%${searchString}%`;
      conditions.push(`wbs_element ILIKE $${paramIndex++}`);
      params.push(searchPattern);
    }

    // Build the query with count
    let query = `SELECT sc.id, sc.wbs_element, sc.description, ARRAY_AGG(ts.name) as activitity, sc.created_at FROM sub_codes sc 
    LEFT JOIN trade_section_sub_code tssc ON tssc.sub_code_id = sc.id 
    LEFT JOIN trade_sections ts ON ts.id = tssc.trade_section_id`;
    let countQuery = `SELECT COUNT(*) as total_count FROM sub_codes`;

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
      countQuery += ' WHERE ' + conditions.join(' AND ');
      countParams = [...params];
    }

    query += ' GROUP BY sc.id, sc.wbs_element, sc.description, sc.project_id';

    // Add sorting
    const validSortColumns = ['sub_no', 'description', 'created_at'];
    const sortColumn = validSortColumns.includes(sortBy) ? (sortBy === 'sub_no' ? 'wbs_element' : sortBy) : 'created_at';
    const sortOrder = orderBy?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    query += ` ORDER BY sc.${sortColumn} ${sortOrder}`;

    // Add pagination
    const limitNum = parseInt(limit, 10) || 10;
    const offsetNum = parseInt(offset, 10) || 0;

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
      await logDatabaseError('Error executing query');
      return new LambdaResponse(400, new ApiResponse(false, null, 'Error executing query', result.error));
    }

    const total = parseInt(countResult.data[0].total_count);

    const responseData = result.data.map(subCode => ({
      id: subCode.id,
      sub_no: subCode.wbs_element,
      description: subCode.description,
      created_at: subCode.created_at,
      activities: subCode.activitity
    }));

    return new LambdaResponse(200, new ApiResponse(true, { pageNumber: offsetNum, pageSize: limitNum, totalCount: total, data: responseData}));
  } catch (error) {
    console.error('Error:', error);
    await logAPIError('Internal server error');
    return new LambdaResponse(400, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};