import { executeQuery } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';

export const handler = async (event: any) => {
  console.log('Receive Event:', event);
  const tradeSectionId = event?.pathParameters?.id;
  try {
    const sql = 'SELECT * FROM trade_sections WHERE id = $1;';
    const params = [tradeSectionId];
    const result = await executeQuery(sql, params);
    console.log('Select result:', result);

    if (result.success && result.rowCount && result.rowCount > 0) {
      return new LambdaResponse(200, new ApiResponse(true, result.data));
    }

    if (result.success && result.rowCount === 0) {
      return new LambdaResponse(404, new ApiResponse(false, null, 'No trade sections found'));
    }
    
    return new LambdaResponse(404, new ApiResponse(false, null, 'Error fetching trade sections', result.error));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};
