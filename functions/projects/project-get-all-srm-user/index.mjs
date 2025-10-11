import { executeQuery, logAPIError, logDatabaseError } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

const roleEnum = {
  'Super User': 0,
  'SRM': 1,
  'Safety Officer': 2,
  'Commercial Officer Admin': 3,
  'Commercial Officer': 4,
  'Guest': 5
};

export const handler = async (event) => {
  try {
    let selectSql = 'SELECT DISTINCT u.id, u.name, u.email FROM project_assignments pa JOIN users u ON pa.user_id = u.id WHERE pa.role = $1;';
    let selectParams = [roleEnum['SRM']];

    const result = await executeQuery(selectSql, selectParams);

    if (result.error) {
      await logDatabaseError(deleteResult.error ?? 'Failed to get SRM user');
      return new LambdaResponse(400, new ApiResponse(false, null, 'Failed to get SRM user', result.error));
    }
    return new LambdaResponse(200, new ApiResponse(true, result.data, 'SRM user retrieved successfully'));
  } catch (error) {
    console.error('Error:', error);
    await logAPIError('Internal server error');
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error?.message || error));
  }
};