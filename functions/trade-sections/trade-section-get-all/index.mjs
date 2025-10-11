import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

export const handler = async (event) => {
  try {
    const selectSql = `SELECT * FROM trade_sections ORDER BY name asc`;
    const result = await executeQuery(selectSql, []);

    if (!result.success) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Database error', result.error));
    }

    return new LambdaResponse(200, new ApiResponse(true, result.data));
  } catch (error) {
    console.error('Error:', error);
    return new LambdaResponse(400, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};