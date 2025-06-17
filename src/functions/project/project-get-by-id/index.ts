import { executeQuery } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';

export const handler = async (event: any) => {
  console.log('Receive Event:', event);
  const id = event?.pathParameters?.id;

  if (!id) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid request'));
  }

  try {
    const sql = 'SELECT * FROM projects WHERE id = $1;';
    const params = [id];
    const result = await executeQuery(sql, params);
    console.log('Select result:', result);
    if (result.error) {
      return new LambdaResponse(500, new ApiResponse(false, null, 'Database error', result.error));
    }
    if (!result.data || result.data.length === 0) {
      return new LambdaResponse(404, new ApiResponse(false, null, 'Project not found!'));
    }
    return new LambdaResponse(200, new ApiResponse(true, result.data));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};
