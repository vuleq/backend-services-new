import { executeQuery } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';

export const handler = async (event: any) => {
  try {
    let selectSql = 'SELECT * FROM jobs;';
    let selectParams: any[] = [];
    const result = await executeQuery(selectSql, selectParams);

    if (result.error) {
      return new LambdaResponse(404, new ApiResponse(false, null, 'Error fetching jobs', result.error));
    }

    if (result.success && result.rowCount === 0) {
      return new LambdaResponse(404, new ApiResponse(false, null, 'No jobs found'));
    }
    
    return new LambdaResponse(200, new ApiResponse(true, result.data));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};
