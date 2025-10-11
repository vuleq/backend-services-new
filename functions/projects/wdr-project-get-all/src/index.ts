import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const projectStatus: Record<string, number> = {
  'Not started': 0,
  Started: 1,
  Completed: 2,
  Closed: 3
};

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // Use multiValueQueryStringParameters for arrays, fallback to single values
  const queryParams = event.queryStringParameters || {};
  const multiValueParams = event.multiValueQueryStringParameters || {};

  const status = (multiValueParams.status && multiValueParams.status.length > 0)
    ? multiValueParams.status
    : (queryParams.status ? [queryParams.status] : []);
  const sortBy = queryParams['sort-by'] ?? 'actual_start_date';
  const orderBy = queryParams['order-by']?.toUpperCase() ?? 'DESC';

  try {
    let selectSql = `SELECT p.id,
        p.main_code,
        p.vessel_name,
        p.created_date,
        p.updated_date,
        p.owner_rep,
        p.ship_contact,
        p.vscc_meeting_time,
        p.vessel_size,
        p.arrival_date,
        p.departure_date,
        p.docking_date,
        p.undocking_date,
        p.plan_start_date,
        p.plan_complete_date,
        p.actual_start_date,
        p.actual_complete_date,
        p.remark,
        p.status,
        p.updated_by FROM projects p`;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (status && status.length > 0) {
      const statusValues = status.map(s => projectStatus[s]).filter(s => s !== undefined);
      if (statusValues.length != status.length) {
        return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid status'));
      }

      if (statusValues.length > 0) {
        conditions.push(`p.status = ANY($${paramIndex++})`);
        params.push(statusValues);
      }
    }

    if (conditions.length > 0) {
      const whereClause = ' WHERE ' + conditions.join(' AND ');
      selectSql += whereClause;
    }

    const validSortColumns = ['main_code', 'vessel_name', 'status', 'created_date', 'actual_start_date', 'actual_complete_date'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'actual_start_date';
    const sortOrder = orderBy?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    selectSql += ` ORDER BY p.${sortColumn} ${sortOrder}`;

    const result = await executeQuery(selectSql, params);

    if (!result.success) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Failed to get projects', result.error));
    }

    return new LambdaResponse(200, new ApiResponse(true, result.data));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(400, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};