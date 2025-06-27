import { executeQuery } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';

export const handler = async (event: any) => {
  console.log('Receive Event:', event);
  let userId = event.params?.path?.userId;
  try {
    const sql = 'SELECT * FROM users WHERE id = $1;';
    const params = [userId];
    const result = await executeQuery(sql, params);
    console.log('Select result:', result);
    if (!result.data || result.data.length === 0) {
      return new LambdaResponse(404, new ApiResponse(false, null, 'User not found!'));
    }
    return new LambdaResponse(200, new ApiResponse(true, result.data));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};
