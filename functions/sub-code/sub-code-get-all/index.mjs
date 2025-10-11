import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

export const handler = async (event) => {
  console.log('Receive Event:', event);
  const projectId = event.queryStringParameters?.['project-id'];

  try {
    let sql = `SELECT * FROM sub_codes`;
    let params = [];
    const conditions = [];

    if (projectId && isValidUUID(projectId)) {
      conditions.push(`project_id = $${params.length + 1}`);
      params.push(projectId);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    const result = await executeQuery(sql, params);

    console.log('Select result:', result);

    if (result.error) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Database error', result.error));
    }

    return new LambdaResponse(200, new ApiResponse(true, result.data ?? []));
  } catch (error) {
    console.error('Error:', error);
    return new LambdaResponse(400, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};


function isValidUUID(uuidString) {
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  return uuidRegex.test(uuidString);
}