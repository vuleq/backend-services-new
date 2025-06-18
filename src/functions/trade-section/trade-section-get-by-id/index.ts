import { executeQuery } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';

export const handler = async (event: any) => {
  console.log('Receive Event:', event);
  const tradeSectionId = event?.pathParameters?.id;

  if (!tradeSectionId) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Trade section id is required'));
  }

  try {
    const sql = 'SELECT * FROM trade_sections WHERE id = $1 AND is_deleted = false;';
    const params = [tradeSectionId];
    const result = await executeQuery(sql, params);
    console.log('Select result:', result);

    if (result.error) {
      return new LambdaResponse(404, new ApiResponse(false, null, 'Error fetching trade_sections', result.error));
    }

    if (result.success && result.rowCount === 0) {
      return new LambdaResponse(404, new ApiResponse(false, null, 'No trade_sections found'));
    }
    
    return new LambdaResponse(200, new ApiResponse(true, result.data));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};
