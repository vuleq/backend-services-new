import { executeQuery } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';

export const handler = async (event: any) => {
  try {
    let selectSql = 'SELECT * FROM projects;';
    let selectParams: any[] = [];
    const result = await executeQuery(selectSql, selectParams);
    if (!result.success) {
      return new LambdaResponse(500, new ApiResponse(false, null, 'Failed to get projects', result.error));
    }
    return new LambdaResponse(200, new ApiResponse(true, result.data));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};
